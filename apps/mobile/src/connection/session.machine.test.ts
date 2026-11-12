import { describe, expect, it } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";
import type { MacState } from "@relay/protocol";
import type { DiscoveredService } from "./discovery";
import { sessionMachine, type ProofInput, type SessionEffect, type SessionEvent } from "./session.machine";

const service: DiscoveredService = { name: "Isaacs-Mac", host: "192.168.1.5", port: 8443, txt: { v: "1" } };
const mac: MacState = { name: "Isaac's Mac", version: "1.0.0", accessibilityGranted: true, agentsAvailable: false };

/** A started session actor with a stub proof, recording every effect it emits. */
function start() {
  const machine = sessionMachine.provide({
    actors: { proof: fromPromise<string, ProofInput>(({ input }) => Promise.resolve(`proof:${input.nonce}`)) },
  });
  const actor = createActor(machine, { input: { deviceId: "d", getDeviceName: () => "iPhone", random: () => 0.5 } }).start();
  const effects: SessionEffect[] = [];
  actor.on("effect", (emitted) => effects.push(emitted.effect));
  return { actor, effects };
}

async function connected() {
  const s = start();
  s.actor.send({ type: "app.active" });
  s.actor.send({ type: "discovery.found", service, pairedSecretHex: "aabb" });
  s.actor.send({ type: "socket.opened" });
  s.actor.send({ type: "host.challenge", nonce: "n" });
  await waitFor(s.actor, (snapshot) => !snapshot.hasTag("proving"));
  s.actor.send({ type: "host.welcome", mac });
  expect(s.actor.getSnapshot().value).toBe("connected");
  s.effects.length = 0;
  return s;
}

describe("session machine states", () => {
  it("walks idle -> discovering -> connecting -> hello -> authenticating -> connected", async () => {
    const { actor, effects } = start();
    expect(actor.getSnapshot().value).toBe("idle");
    actor.send({ type: "app.active" });
    expect(actor.getSnapshot().value).toBe("discovering");
    actor.send({ type: "discovery.found", service, pairedSecretHex: "aabb" });
    expect(actor.getSnapshot().value).toBe("connecting");
    actor.send({ type: "socket.opened" });
    expect(actor.getSnapshot().value).toBe("hello");
    actor.send({ type: "host.challenge", nonce: "n1" });
    expect(actor.getSnapshot().value).toEqual({ authenticating: "proving" });
    await waitFor(actor, (snapshot) => snapshot.matches({ authenticating: "waiting" }));
    expect(effects.at(-1)).toEqual({ type: "send", message: { t: "auth", proof: "proof:n1" } });
    actor.send({ type: "host.welcome", mac });
    expect(actor.getSnapshot().value).toBe("connected");
  });

  it("refuses transitions a state has no business taking", async () => {
    const idle = start().actor.getSnapshot();
    const events: SessionEvent[] = [
      { type: "socket.opened" },
      { type: "timer.fired", now: 0 },
      { type: "host.welcome", mac },
      { type: "pairing.start" },
    ];
    for (const event of events) expect(idle.can(event)).toBe(false);

    const { actor } = await connected();
    const live = actor.getSnapshot();
    expect(live.can({ type: "host.challenge", nonce: "again" })).toBe(false);
    expect(live.can({ type: "host.welcome", mac })).toBe(false);
    expect(live.can({ type: "socket.opened" })).toBe(false);
    expect(live.can({ type: "pairing.pin", pin: "123456" })).toBe(false);
    // Not resuming and not idle: a second app.active does nothing.
    expect(live.can({ type: "app.active" })).toBe(false);
  });
});

describe("session machine guards", () => {
  it("hasSecret: a challenge without a paired secret is refused", () => {
    const { actor } = start();
    actor.send({ type: "app.active" });
    actor.send({ type: "discovery.found", service, pairedSecretHex: null });
    actor.send({ type: "socket.opened" });
    expect(actor.getSnapshot().can({ type: "host.challenge", nonce: "n" })).toBe(false);
  });

  it("validPin and wrongPin: only six digits go out; a wrong PIN stays on the PIN", () => {
    const { actor, effects } = start();
    actor.send({ type: "app.active" });
    actor.send({ type: "discovery.found", service, pairedSecretHex: null });
    actor.send({ type: "socket.opened" });
    actor.send({ type: "host.unpaired" });
    actor.send({ type: "host.pairPending" });
    expect(actor.getSnapshot().value).toBe("pairing_pin");
    expect(actor.getSnapshot().can({ type: "pairing.pin", pin: "12345" })).toBe(false);
    expect(actor.getSnapshot().can({ type: "pairing.pin", pin: "123456" })).toBe(true);
    actor.send({ type: "host.pairFailed", reason: "wrong_pin" });
    expect(actor.getSnapshot().value).toBe("pairing_pin");
    actor.send({ type: "host.pairFailed", reason: "timeout" });
    expect(actor.getSnapshot().value).toBe("hello");
    expect(effects.at(-1)).toEqual({
      type: "storeUpdate",
      partial: { status: "pairing", pairing: { pinRequired: false, failure: "timeout" } },
    });
  });

  it("credentialRejected, hostBusy and a fatal error each go their own way", async () => {
    const rejected = await connected();
    rejected.actor.send({ type: "host.error", code: "auth_failed", message: "x" });
    expect(rejected.actor.getSnapshot().value).toBe("needs_pairing");
    expect(rejected.effects[0]).toEqual({ type: "forgetSecret" });

    const busy = await connected();
    busy.actor.send({ type: "host.error", code: "busy", message: "x" });
    expect(busy.actor.getSnapshot().value).toBe("backoff");

    const fatal = await connected();
    fatal.actor.send({ type: "host.error", code: "version_mismatch", message: "update" });
    expect(fatal.actor.getSnapshot().value).toBe("offline");
    expect(fatal.effects).toEqual([{ type: "storeUpdate", partial: { status: "offline", lastError: "update" } }]);
  });

  it("heartbeatLost and answersLastPing: two unanswered pings lose the socket, a matching pong keeps it", async () => {
    const { actor } = await connected();
    actor.send({ type: "timer.fired", now: 1000 });
    actor.send({ type: "host.pong", ts: 999, now: 1010 });
    expect(actor.getSnapshot().context.awaitingPong).toBe(true);
    actor.send({ type: "host.pong", ts: 1000, now: 1040 });
    expect(actor.getSnapshot().context.lastRttMs).toBe(40);
    actor.send({ type: "timer.fired", now: 6000 });
    actor.send({ type: "timer.fired", now: 11000 });
    expect(actor.getSnapshot().value).toBe("connected");
    actor.send({ type: "timer.fired", now: 16000 });
    expect(actor.getSnapshot().value).toBe("backoff");
  });

  it("atRest and inBackoff: a close changes nothing at rest and does not count a new attempt in backoff", async () => {
    const idle = start();
    idle.actor.send({ type: "socket.closed" });
    expect(idle.actor.getSnapshot().value).toBe("idle");
    expect(idle.effects).toEqual([]);

    const { actor, effects } = await connected();
    actor.send({ type: "socket.closed" });
    actor.send({ type: "socket.closed" });
    expect(actor.getSnapshot().value).toBe("backoff");
    expect(actor.getSnapshot().context.attempts).toBe(1);
    expect(effects.filter((e) => e.type === "scheduleRetry")).toEqual([
      { type: "scheduleRetry", ms: 500 },
      { type: "scheduleRetry", ms: 500 },
    ]);
  });

  it("noCandidate: losing the socket with no known host goes back to discovering", () => {
    const { actor } = start();
    actor.send({ type: "app.active" });
    actor.send({ type: "host.error", code: "busy", message: "x" });
    expect(actor.getSnapshot().value).toBe("discovering");
  });
});

describe("session machine status is never stale", () => {
  it("every move into offline or backoff emits a storeUpdate with that status", async () => {
    const lost = await connected();
    lost.actor.send({ type: "socket.closed" });
    expect(lost.effects[0]).toEqual({ type: "storeUpdate", partial: { status: "reconnecting" } });

    const background = await connected();
    background.actor.send({ type: "app.background" });
    expect(background.actor.getSnapshot().value).toBe("offline");
    expect(background.effects).toEqual([{ type: "storeUpdate", partial: { status: "offline" } }]);

    // backgrounded: resuming reconnects at once.
    background.actor.send({ type: "app.active" });
    expect(background.actor.getSnapshot().value).toBe("connecting");
  });

  it("backgrounding while discovering stops discovery before saying offline", () => {
    const { actor, effects } = start();
    actor.send({ type: "app.active" });
    effects.length = 0;
    actor.send({ type: "app.background" });
    expect(effects).toEqual([{ type: "stopDiscovery" }, { type: "storeUpdate", partial: { status: "offline" } }]);
  });
});
