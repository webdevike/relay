import { describe, expect, it } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";
import { holdReason, otaGateMachine, QUIET, type AppStateName, type QuietReason, type QuietSignals } from "./otaGate.machine";

interface Options {
  appState?: AppStateName;
  signals?: QuietSignals;
  available?: boolean;
}

function harness({ appState = "active", signals = QUIET, available = true }: Options = {}) {
  const calls = { check: 0, fetch: 0, reload: 0 };
  const machine = otaGateMachine.provide({
    actors: {
      checkForUpdate: fromPromise(() => {
        calls.check += 1;
        return Promise.resolve(available);
      }),
      fetchUpdate: fromPromise(() => {
        calls.fetch += 1;
        return Promise.resolve(true);
      }),
      // Never settles: the real one replaces the JS world.
      reload: fromPromise<unknown>(() => {
        calls.reload += 1;
        return new Promise<unknown>(() => undefined);
      }),
    },
  });
  const actor = createActor(machine, { input: { appState, signals } }).start();
  const settled = () =>
    waitFor(actor, (snapshot) => snapshot.matches("idle") || snapshot.matches("ready") || snapshot.matches("reloading"));
  return { actor, calls, settled, value: () => actor.getSnapshot().value };
}

const held: [QuietReason, Partial<QuietSignals>][] = [
  ["legacyCall", { legacyCall: true }],
  ["liveCall", { liveCall: true }],
  ["commands", { commandsOutstanding: 2 }],
  ["dictation", { dictationIdle: false }],
  ["composer", { composerBusy: true }],
];

describe("holdReason", () => {
  it("is null only when everything is at rest", () => {
    expect(holdReason(QUIET)).toBeNull();
    for (const [reason, change] of held) expect(holdReason({ ...QUIET, ...change })).toBe(reason);
  });
});

describe("otaGate", () => {
  it("reloads once a found update is downloaded while active and quiet", async () => {
    const { actor, calls, settled } = harness();
    actor.send({ type: "ota.check" });
    expect((await settled()).value).toBe("reloading");
    expect(calls).toEqual({ check: 1, fetch: 1, reload: 1 });
  });

  it("goes back to idle when the server has nothing new", async () => {
    const { actor, calls, settled } = harness({ available: false });
    actor.send({ type: "ota.check" });
    const snapshot = await settled();
    expect(snapshot.value).toBe("idle");
    expect(snapshot.context.result).toBe("up-to-date");
    expect(calls.fetch).toBe(0);
  });

  it("reports a failed check as failed, without reloading", async () => {
    const machine = otaGateMachine.provide({
      actors: { checkForUpdate: fromPromise<boolean>(() => Promise.reject(new Error("offline"))) },
    });
    const actor = createActor(machine, { input: { appState: "active", signals: QUIET } }).start();
    actor.send({ type: "ota.check" });
    const snapshot = await waitFor(actor, (s) => s.matches("idle") && s.context.result !== null);
    expect(snapshot.context.result).toBe("failed");
  });

  for (const [reason, change] of held) {
    it(`waits in ready while ${reason} holds it, and reloads once it goes quiet`, async () => {
      const busy = { ...QUIET, ...change };
      const { actor, calls, settled, value } = harness({ signals: busy });
      actor.send({ type: "ota.check" });
      expect((await settled()).value).toBe("ready");
      expect(calls.reload).toBe(0);
      // Unrelated churn keeps it waiting.
      actor.send({ type: "ota.signals", signals: { ...busy } });
      actor.send({ type: "ota.appState", state: "inactive" });
      actor.send({ type: "ota.appState", state: "active" });
      expect(value()).toBe("ready");
      actor.send({ type: "ota.signals", signals: QUIET });
      expect(value()).toBe("reloading");
      expect(calls.reload).toBe(1);
    });
  }

  it("waits in ready while the app is not in front, then reloads when it comes back quiet", async () => {
    const { actor, calls, settled, value } = harness({ appState: "background" });
    actor.send({ type: "ota.check" });
    expect((await settled()).value).toBe("ready");
    actor.send({ type: "ota.appState", state: "inactive" });
    expect(value()).toBe("ready");
    actor.send({ type: "ota.appState", state: "active" });
    expect(value()).toBe("reloading");
    expect(calls.reload).toBe(1);
  });

  it("checks again on a return from the background", async () => {
    const { actor, calls, settled } = harness({ available: false });
    actor.send({ type: "ota.appState", state: "background" });
    expect(calls.check).toBe(0);
    actor.send({ type: "ota.appState", state: "active" });
    expect(actor.getSnapshot().value).toBe("checking");
    await settled();
    expect(calls.check).toBe(1);
  });

  it("checks on background -> inactive -> active (Face ID on return)", () => {
    const { actor, calls } = harness({ available: false });
    actor.send({ type: "ota.appState", state: "background" });
    actor.send({ type: "ota.appState", state: "inactive" });
    actor.send({ type: "ota.appState", state: "active" });
    expect(calls.check).toBe(1);
  });

  it("does not check on an inactive -> active bounce", () => {
    const { actor, calls, value } = harness();
    actor.send({ type: "ota.appState", state: "inactive" });
    actor.send({ type: "ota.appState", state: "active" });
    expect(value()).toBe("idle");
    expect(calls.check).toBe(0);
  });

  it("refuses a second check while one runs", async () => {
    const { actor, calls, settled } = harness({ available: false });
    actor.send({ type: "ota.check" });
    expect(actor.getSnapshot().can({ type: "ota.check" })).toBe(false);
    await settled();
    expect(calls.check).toBe(1);
  });

  it("refuses a check while ready: the server is not asked again", async () => {
    const { actor, calls, settled } = harness({ signals: { ...QUIET, composerBusy: true } });
    actor.send({ type: "ota.check" });
    await settled();
    expect(actor.getSnapshot().can({ type: "ota.check" })).toBe(false);
    expect(calls.check).toBe(1);
  });
});
