import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authProof, type MacState, type Sha256 } from "@relay/protocol";
import { SessionMachine, type Effect } from "./session";
import type { DiscoveredService } from "./discovery";

const sha256: Sha256 = (data) => webcrypto.subtle.digest("SHA-256", data);
const noJitter = (): number => 0.5; // (0.5 * 2 - 1) === 0 -> backoffDelay returns the exact base

const service: DiscoveredService = { name: "Isaacs-Mac", host: "192.168.1.5", port: 8443, txt: { v: "1" } };
const mac: MacState = { name: "Isaac's Mac", version: "1.0.0", accessibilityGranted: true, agentsAvailable: false };

function machine(pairedSecretHex: string | null = null): SessionMachine {
  return new SessionMachine({
    sha256,
    deviceId: "device-1",
    getDeviceName: () => "iPhone",
    pairedSecretHex,
    random: noJitter,
  });
}

describe("SessionMachine full pairing path", () => {
  it("produces the exact handshake -> pairing -> connected effect sequence in order", async () => {
    const m = machine();
    const effects: Effect[] = [];
    const step = async (input: Parameters<SessionMachine["handle"]>[0], now: number): Promise<void> => {
      effects.push(...(await m.handle(input, now)));
    };

    await step({ type: "appActive" }, 0);
    await step({ type: "serviceFound", service }, 10);
    await step({ type: "socketOpen" }, 20);
    await step({ type: "server", message: { t: "unpaired" } }, 30);
    await step({ type: "startPairing" }, 40);
    await step({ type: "server", message: { t: "pair.pending" } }, 50);
    await step({ type: "pinEntered", pin: "123456" }, 60);
    await step({ type: "server", message: { t: "pair.ok", secret: "aabbcc" } }, 70);
    await step({ type: "server", message: { t: "welcome", state: { mac, agents: { rev: 0, sessions: [] } } } }, 80);

    expect(effects).toEqual([
      { type: "storeUpdate", partial: { status: "discovering" } },
      { type: "startDiscovery" },
      { type: "stopDiscovery" },
      { type: "storeUpdate", partial: { status: "connecting" } },
      { type: "connect", host: "192.168.1.5", port: 8443 },
      { type: "send", message: { t: "hello", v: 1, deviceId: "device-1", deviceName: "iPhone", platform: "ios" } },
      { type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: null } } },
      { type: "send", message: { t: "pair.request" } },
      { type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: null } } },
      { type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: true, failure: null } } },
      { type: "send", message: { t: "pair.confirm", pin: "123456" } },
      { type: "storeSecret", hex: "aabbcc" },
      {
        type: "storeUpdate",
        partial: { status: "connected", mac, macName: mac.name, lastError: null, pairing: { pinRequired: false, failure: null } },
      },
      { type: "scheduleRetry", ms: 5000 },
    ]);
    expect(m.currentState).toBe("connected");
  });
});

describe("SessionMachine known-device auth", () => {
  it("answers a challenge with a real HMAC proof computed from the paired secret", async () => {
    const secretHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddee";
    const m = machine(secretHex);
    await m.handle({ type: "appActive" }, 0);
    await m.handle({ type: "serviceFound", service }, 0);
    await m.handle({ type: "socketOpen" }, 0);

    const effects = await m.handle({ type: "server", message: { t: "challenge", nonce: "nonce-xyz" } }, 0);

    const expectedProof = await authProof(secretHex, "nonce-xyz", sha256);
    expect(effects).toEqual([{ type: "send", message: { t: "auth", proof: expectedProof } }]);
    expect(m.currentState).toBe("authenticating");
  });
});

describe("SessionMachine unknown_device error", () => {
  it("forgets the secret and returns to the pairing-wait state", async () => {
    const m = machine("some-secret-hex");
    await m.handle({ type: "appActive" }, 0);
    await m.handle({ type: "serviceFound", service }, 0);
    await m.handle({ type: "socketOpen" }, 0);

    const effects = await m.handle(
      { type: "server", message: { t: "error", code: "unknown_device", message: "no longer registered" } },
      0,
    );

    expect(effects).toEqual([
      { type: "forgetSecret" },
      { type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: null }, mac: null, macName: null } },
    ]);
    expect(m.currentState).toBe("hello");
  });
});

describe("SessionMachine backoff", () => {
  it("escalates 0.5s/1s/2s/4s/5s capped, then resets to 0.5s after reconnecting", async () => {
    const m = machine("aabbccdd");
    await m.handle({ type: "appActive" }, 0);
    await m.handle({ type: "serviceFound", service }, 0);

    const scheduledDelays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const closedEffects = await m.handle({ type: "socketClosed" }, 0);
      expect(m.currentState).toBe("backoff");
      const retry = closedEffects.find((e): e is Extract<Effect, { type: "scheduleRetry" }> => e.type === "scheduleRetry");
      scheduledDelays.push(retry?.ms ?? -1);
      await m.handle({ type: "timer" }, 0); // fires the retry -> back to "connecting"
      expect(m.currentState).toBe("connecting");
    }
    expect(scheduledDelays).toEqual([500, 1000, 2000, 4000, 5000, 5000]);

    // A real connect resets the backoff counter.
    await m.handle({ type: "socketOpen" }, 0);
    await m.handle({ type: "server", message: { t: "challenge", nonce: "n" } }, 0);
    await m.handle({ type: "server", message: { t: "welcome", state: { mac, agents: { rev: 0, sessions: [] } } } }, 0);
    expect(m.currentState).toBe("connected");

    const afterReset = await m.handle({ type: "socketClosed" }, 0);
    const retry = afterReset.find((e): e is Extract<Effect, { type: "scheduleRetry" }> => e.type === "scheduleRetry");
    expect(retry?.ms).toBe(500);
  });
});

describe("SessionMachine app lifecycle", () => {
  it("suppresses retries while backgrounded and reconnects immediately on resume", async () => {
    const m = machine("aabbccdd");
    await m.handle({ type: "appActive" }, 0);
    await m.handle({ type: "serviceFound", service }, 0);
    await m.handle({ type: "socketClosed" }, 0); // now in backoff, a retry timer is conceptually pending
    expect(m.currentState).toBe("backoff");

    const backgroundEffects = await m.handle({ type: "appBackground" }, 0);
    expect(backgroundEffects).toEqual([]);

    // Even if the driver's stale backoff timer still fires, the machine must not act on it.
    const staleTimerEffects = await m.handle({ type: "timer" }, 100);
    expect(staleTimerEffects).toEqual([]);

    const resumeEffects = await m.handle({ type: "appActive" }, 200);
    expect(resumeEffects).toEqual([
      { type: "storeUpdate", partial: { status: "connecting" } },
      { type: "connect", host: "192.168.1.5", port: 8443 },
    ]);
    expect(m.currentState).toBe("connecting");
  });

  it("rediscovers on resume when no candidate was ever found", async () => {
    const m = machine();
    await m.handle({ type: "appBackground" }, 0);
    const resumeEffects = await m.handle({ type: "appActive" }, 0);
    expect(resumeEffects).toEqual([{ type: "storeUpdate", partial: { status: "discovering" } }, { type: "startDiscovery" }]);
  });
});

describe("SessionMachine heartbeat", () => {
  it("treats two consecutive missed pongs as a closed connection", async () => {
    const m = machine("aabbccdd");
    await m.handle({ type: "appActive" }, 0);
    await m.handle({ type: "serviceFound", service }, 0);
    await m.handle({ type: "socketOpen" }, 0);
    await m.handle({ type: "server", message: { t: "challenge", nonce: "n" } }, 0);
    await m.handle({ type: "server", message: { t: "welcome", state: { mac, agents: { rev: 0, sessions: [] } } } }, 0);
    expect(m.currentState).toBe("connected");

    const ping1 = await m.handle({ type: "timer" }, 1000); // first ping sent, nothing missed yet
    expect(ping1).toEqual([
      { type: "send", message: { t: "ping", ts: 1000 } },
      { type: "scheduleRetry", ms: 5000 },
    ]);
    expect(m.currentState).toBe("connected");

    const ping2 = await m.handle({ type: "timer" }, 6000); // no pong arrived for ping1 -> one missed
    expect(ping2).toEqual([
      { type: "send", message: { t: "ping", ts: 6000 } },
      { type: "scheduleRetry", ms: 5000 },
    ]);
    expect(m.currentState).toBe("connected");

    const closed = await m.handle({ type: "timer" }, 11000); // no pong arrived for ping2 either -> two missed
    expect(m.currentState).toBe("backoff");
    expect(closed.some((e) => e.type === "scheduleRetry")).toBe(true);
  });

  it("resets the missed-pong count when a pong arrives", async () => {
    const m = machine("aabbccdd");
    await m.handle({ type: "appActive" }, 0);
    await m.handle({ type: "serviceFound", service }, 0);
    await m.handle({ type: "socketOpen" }, 0);
    await m.handle({ type: "server", message: { t: "challenge", nonce: "n" } }, 0);
    await m.handle({ type: "server", message: { t: "welcome", state: { mac, agents: { rev: 0, sessions: [] } } } }, 0);

    await m.handle({ type: "timer" }, 1000); // ping sent
    await m.handle({ type: "server", message: { t: "pong", ts: 1000, serverTs: 1000 } }, 1050);
    expect(m.rttMs).toBe(50);

    // A fresh ping cycle with no prior miss must not be treated as already-missed.
    const ping = await m.handle({ type: "timer" }, 6000);
    expect(ping).toEqual([
      { type: "send", message: { t: "ping", ts: 6000 } },
      { type: "scheduleRetry", ms: 5000 },
    ]);
    expect(m.currentState).toBe("connected");
  });
});
