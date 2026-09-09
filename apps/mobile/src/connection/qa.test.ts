import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AckError, type ClientMessage, type Command, type MacState, type Sha256 } from "@relay/protocol";
import { SessionMachine, type Effect, type SessionState } from "./session";
import { CommandQueue } from "./commands";
import type { DiscoveredService } from "./discovery";

const sha256: Sha256 = (data) => webcrypto.subtle.digest("SHA-256", data);
const noJitter = (): number => 0.5;

const service: DiscoveredService = { name: "Isaacs-Mac", host: "192.168.1.5", port: 8443, txt: { v: "1" } };
const mac: MacState = { name: "Isaac's Mac", version: "1.0.0", accessibilityGranted: true, agentsAvailable: false };
const welcome = { t: "welcome" as const, state: { mac, agents: { rev: 0, sessions: [] } } };

function machine(pairedSecretHex: string | null = null): SessionMachine {
  return new SessionMachine({ sha256, deviceId: "device-1", getDeviceName: () => "iPhone", pairedSecretHex, random: noJitter });
}

/** Drives a fresh, paired machine to exactly `state` via the shortest realistic path. */
async function reach(state: SessionState): Promise<SessionMachine> {
  const m = machine("aabbccdd");
  if (state === "idle") return m;
  await m.handle({ type: "appActive" }, 0);
  if (state === "discovering") return m;
  await m.handle({ type: "serviceFound", service }, 0);
  if (state === "connecting") return m;
  await m.handle({ type: "socketOpen" }, 0);
  if (state === "hello") return m;
  if (state === "pairing_request") {
    await m.handle({ type: "startPairing" }, 0);
    return m;
  }
  if (state === "pairing_pin") {
    await m.handle({ type: "startPairing" }, 0);
    await m.handle({ type: "server", message: { t: "pair.pending" } }, 0);
    return m;
  }
  await m.handle({ type: "server", message: { t: "challenge", nonce: "n" } }, 0);
  if (state === "authenticating") return m;
  await m.handle({ type: "server", message: welcome }, 0);
  if (state === "connected") return m;
  await m.handle({ type: "socketClosed" }, 0);
  if (state === "backoff") return m;
  // Only "offline" remains once every other SessionState has returned above.
  await m.handle({ type: "appBackground" }, 0);
  return m;
}

describe("SessionMachine socketClosed in every state", () => {
  const restStates: SessionState[] = ["idle", "discovering", "offline"];
  const liveStates: SessionState[] = [
    "connecting",
    "hello",
    "pairing_request",
    "pairing_pin",
    "authenticating",
    "connected",
    "backoff",
  ];

  it.each(restStates)("leaves an at-rest state (%s) untouched with no effects", async (state) => {
    const m = await reach(state);
    const effects = await m.handle({ type: "socketClosed" }, 0);
    expect(effects).toEqual([]);
    expect(m.currentState).toBe(state);
  });

  it.each(liveStates)("recovers a live state (%s) into backoff or discovering, never stuck", async (state) => {
    const m = await reach(state);
    const effects = await m.handle({ type: "socketClosed" }, 0);
    expect(["backoff", "discovering"]).toContain(m.currentState);
    const progressEffect = effects.find((e) => e.type === "scheduleRetry" || e.type === "startDiscovery");
    expect(progressEffect).toBeDefined();
  });
});

describe("SessionMachine duplicate/out-of-phase server messages", () => {
  it("a second welcome while already connected is a no-op", async () => {
    const m = await reach("connected");
    const before = m.rttMs;
    const effects = await m.handle({ type: "server", message: welcome }, 100);
    expect(effects).toEqual([]);
    expect(m.currentState).toBe("connected");
    expect(m.rttMs).toBe(before);
  });

  it("a stray challenge while already connected is ignored, not re-authenticated", async () => {
    const m = await reach("connected");
    const effects = await m.handle({ type: "server", message: { t: "challenge", nonce: "unexpected" } }, 0);
    expect(effects).toEqual([]);
    expect(m.currentState).toBe("connected");
  });
});

describe("SessionMachine pairing retry after timeout", () => {
  it("pair.failed (timeout) returns to hello, and the user can restart pairing from there", async () => {
    const m = await reach("pairing_pin");
    const failed = await m.handle({ type: "server", message: { t: "pair.failed", reason: "timeout" } }, 0);
    expect(m.currentState).toBe("hello");
    expect(failed).toEqual([
      { type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: "timeout" } } },
    ]);

    // A stray pin entry while back at "hello" must not be treated as a pairing_pin submission.
    expect(await m.handle({ type: "pinEntered", pin: "111111" }, 0)).toEqual([]);

    const retry = await m.handle({ type: "startPairing" }, 0);
    expect(m.currentState).toBe("pairing_request");
    expect(retry).toEqual([
      { type: "send", message: { t: "pair.request" } },
      { type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: null } } },
    ]);
  });
});

describe("SessionMachine appBackground/appActive around backoff", () => {
  it("produces exactly one connect effect resuming from backoff with a known candidate", async () => {
    const m = await reach("backoff");
    await m.handle({ type: "appBackground" }, 0);
    const resumeEffects = await m.handle({ type: "appActive" }, 0);
    const connectEffects = resumeEffects.filter((e) => e.type === "connect");
    expect(connectEffects).toHaveLength(1);
    expect(m.currentState).toBe("connecting");
  });
});

describe("SessionMachine heartbeat under stress", () => {
  it("stops pinging once two misses close the connection; the next timer drives backoff's reconnect, not a third ping", async () => {
    const m = await reach("connected");
    await m.handle({ type: "timer" }, 1000);
    await m.handle({ type: "timer" }, 6000);
    const closed = await m.handle({ type: "timer" }, 11000);
    expect(m.currentState).toBe("backoff");
    expect(closed.some((e) => e.type === "send")).toBe(false);

    const next = await m.handle({ type: "timer" }, 11500);
    expect(next.some((e) => e.type === "connect")).toBe(true);
    expect(next.some((e) => e.type === "send" && e.message.t === "ping")).toBe(false);
  });
});

describe("SessionMachine backoff jitter bounds", () => {
  it("keeps every jittered delay within [0.4s, 6s] across 200 real-random iterations", async () => {
    const delays: number[] = [];
    for (let trial = 0; trial < 200; trial++) {
      const targetAttempts = (trial % 6) + 1; // cycles 1..6, covering the capped 5th+ tier too
      const m = new SessionMachine({
        sha256,
        deviceId: "d",
        getDeviceName: () => "iPhone",
        pairedSecretHex: "aabbccdd",
        random: Math.random,
      });
      await m.handle({ type: "appActive" }, 0);
      await m.handle({ type: "serviceFound", service }, 0);
      let lastMs = -1;
      for (let attempt = 0; attempt < targetAttempts; attempt++) {
        const closed = await m.handle({ type: "socketClosed" }, 0);
        const retry = closed.find((e): e is Extract<Effect, { type: "scheduleRetry" }> => e.type === "scheduleRetry");
        lastMs = retry?.ms ?? -1;
        if (attempt < targetAttempts - 1) await m.handle({ type: "timer" }, 0);
      }
      delays.push(lastMs);
    }
    expect(delays).toHaveLength(200);
    for (const ms of delays) {
      expect(ms).toBeGreaterThanOrEqual(400);
      expect(ms).toBeLessThanOrEqual(6000);
    }
  });
});

describe("SessionMachine effect ordering on pair.ok", () => {
  it("emits only storeSecret, with no status update that could race a reconnect before the secret is persisted", async () => {
    const m = await reach("pairing_pin");
    const effects = await m.handle({ type: "server", message: { t: "pair.ok", secret: "deadbeef" } }, 0);
    expect(effects).toEqual([{ type: "storeSecret", hex: "deadbeef" }]);
    expect(m.currentState).toBe("authenticating");
  });
});

const insertText = { kind: "text.insert" as const, text: "hi" };

function cmdsOf(sent: ClientMessage[]): Extract<ClientMessage, { t: "cmd" }>[] {
  return sent.filter((m): m is Extract<ClientMessage, { t: "cmd" }> => m.t === "cmd");
}

/** Narrows a `Command` to its `text.insert` payload; throws for any other kind (test-only helper). */
function textInsertPayload(cmd: Command): string {
  if (cmd.kind !== "text.insert") throw new Error(`expected a text.insert command, got ${cmd.kind}`);
  return cmd.text;
}

describe("CommandQueue ack/nack for an unrelated id", () => {
  it("acking an unknown id never resolves or rejects a different, real pending command", async () => {
    const queue = new CommandQueue();
    let settled: "resolved" | "rejected" | null = null;
    const promise = queue.enqueue(insertText).then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    queue.onAck("totally-unknown-id");
    queue.onNack("also-unknown", { code: "internal", message: "x" });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeNull();
    expect(queue.size).toBe(1);

    const sent: ClientMessage[] = [];
    queue.flush((m) => sent.push(m));
    const [real] = cmdsOf(sent);
    if (real === undefined) throw new Error("expected a cmd frame");
    queue.onAck(real.id);
    await promise;
    expect(settled).toBe("resolved");
  });
});

describe("CommandQueue timeout/nack races", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a nack arriving after the command already timed out is a no-op", async () => {
    const queue = new CommandQueue();
    const promise = queue.enqueue(insertText);
    const sent: ClientMessage[] = [];
    queue.flush((m) => sent.push(m));
    const [real] = cmdsOf(sent);
    if (real === undefined) throw new Error("expected a cmd frame");

    const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    const lateError: AckError = { code: "internal", message: "late" };
    expect(() => {
      queue.onNack(real.id, lateError);
    }).not.toThrow();
    expect(queue.size).toBe(0);
  });
});

describe("CommandQueue at the 64-pending boundary", () => {
  it("resends exactly 64 pending commands, in enqueue order, on reconnect", async () => {
    const queue = new CommandQueue();
    const promises = Array.from({ length: 64 }, (_, i) =>
      queue.enqueue({ kind: "text.insert", text: `cmd-${i}` }),
    );
    expect(queue.size).toBe(64);

    const sent: ClientMessage[] = [];
    queue.onReconnect((m) => sent.push(m));
    const cmds = cmdsOf(sent);
    expect(cmds).toHaveLength(64);
    expect(cmds.map((c) => textInsertPayload(c.cmd))).toEqual(
      Array.from({ length: 64 }, (_, i) => `cmd-${i}`),
    );
    expect(new Set(cmds.map((c) => c.id)).size).toBe(64);

    for (const c of cmds) queue.onAck(c.id);
    await Promise.all(promises);
    expect(queue.size).toBe(0);
  });
});

describe("CommandQueue reentrant enqueue during flush", () => {
  it("does not lose or duplicate a command enqueued from inside a flush callback", async () => {
    const queue = new CommandQueue();
    const promiseA = queue.enqueue({ kind: "text.insert", text: "a" });
    const sent: ClientMessage[] = [];
    let reentered = false;
    queue.flush((message) => {
      sent.push(message);
      if (!reentered) {
        reentered = true;
        void queue.enqueue({ kind: "text.insert", text: "b" });
      }
    });

    const aSent = cmdsOf(sent).filter((c) => textInsertPayload(c.cmd) === "a");
    expect(aSent).toHaveLength(1);
    expect(queue.size).toBe(2);

    const finalSent: ClientMessage[] = [];
    queue.flush((m) => finalSent.push(m));
    for (const m of cmdsOf(finalSent)) queue.onAck(m.id);
    await promiseA;
  });
});
