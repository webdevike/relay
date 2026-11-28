import { describe, expect, it, vi } from "vitest";
import { createActor, fromPromise, SimulatedClock, waitFor } from "xstate";
import { RateLimited } from "../src/tickets/budget";
import { backoffFor, ticketsSyncMachine, TICKETS_SYNC_TIMING, type IdentifyOutput, type LinearStepOutput } from "../src/tickets/sync.machine";

const timing = { ...TICKETS_SYNC_TIMING, random: () => 0.5 };

/** Steps that resolve at once unless a test replaces them; each is a spy. */
function setup(over: Partial<Record<"identify" | "linear" | "github" | "reconcile" | "wipe", () => Promise<unknown>>> = {}) {
  const steps = {
    identify: vi.fn(over.identify ?? (() => Promise.resolve<IdentifyOutput>({ kind: "same" }))),
    linear: vi.fn(over.linear ?? (() => Promise.resolve<LinearStepOutput>({ reconcileDue: false }))),
    github: vi.fn(over.github ?? (() => Promise.resolve(null))),
    reconcile: vi.fn(over.reconcile ?? (() => Promise.resolve(null))),
    wipe: vi.fn(over.wipe ?? (() => Promise.resolve(null))),
  };
  const machine = ticketsSyncMachine.provide({
    actors: {
      identify: fromPromise(() => steps.identify() as Promise<IdentifyOutput>),
      linear: fromPromise(() => steps.linear() as Promise<LinearStepOutput>),
      github: fromPromise(() => steps.github() as Promise<null>),
      reconcile: fromPromise(() => steps.reconcile() as Promise<null>),
      wipe: fromPromise(() => steps.wipe() as Promise<null>),
    },
  });
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { timing }, clock }).start();
  return { actor, clock, steps };
}

describe("ticketsSyncMachine", () => {
  it("runs identify, linear, github, then waits about two minutes and runs again", async () => {
    const { actor, clock, steps } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    expect(steps.linear).toHaveBeenCalledOnce();
    expect(steps.github).toHaveBeenCalledOnce();
    expect(steps.reconcile).not.toHaveBeenCalled();
    // 30 s cooldown, then the rest of 120 s +-10% (the jitter draw is the middle here).
    clock.increment(timing.cooldownMs);
    clock.increment(89_999);
    expect(actor.getSnapshot().matches("waiting")).toBe(true);
    clock.increment(1);
    await waitFor(actor, (s) => s.matches("waiting") && steps.linear.mock.calls.length === 2);
  });

  it("reconciles only when the linear step says it is due", async () => {
    const { actor, steps } = setup({ linear: () => Promise.resolve({ reconcileDue: true }) });
    await waitFor(actor, (s) => s.matches("waiting"));
    expect(steps.reconcile).toHaveBeenCalledOnce();
  });

  it("collapses sync.now during a cycle into one follow-up, no sooner than the cooldown", async () => {
    let release: () => void = () => undefined;
    const { actor, clock, steps } = setup({
      linear: () => {
        const { promise, resolve } = Promise.withResolvers<LinearStepOutput>();
        release = () => resolve({ reconcileDue: false });
        return promise;
      },
    });
    await waitFor(actor, (s) => s.matches({ syncing: "linear" }));
    for (let i = 0; i < 5; i++) actor.send({ type: "sync.now" });
    release();
    await waitFor(actor, (s) => s.matches("waiting"));
    expect(actor.getSnapshot().context.followUp).toBe(true);
    clock.increment(timing.cooldownMs - 1);
    expect(actor.getSnapshot().matches("waiting")).toBe(true);
    clock.increment(1);
    await waitFor(actor, (s) => s.matches({ syncing: "linear" }));
    release();
    await waitFor(actor, (s) => s.matches("waiting"));
    expect(steps.linear).toHaveBeenCalledTimes(2);
    expect(actor.getSnapshot().context.followUp).toBe(false);
  });

  it("runs a forced sync at once after the cooldown", async () => {
    const { actor, clock, steps } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    clock.increment(timing.cooldownMs);
    expect(actor.getSnapshot().matches({ waiting: "resting" })).toBe(true);
    actor.send({ type: "sync.now" });
    await waitFor(actor, (s) => s.matches("waiting") && steps.linear.mock.calls.length === 2);
  });

  it("backs off for at least the provider's Retry-After and ignores sync.now meanwhile", async () => {
    let fail = true;
    const { actor, clock, steps } = setup({
      linear: () => (fail ? Promise.reject(new RateLimited("linear", 90_000)) : Promise.resolve({ reconcileDue: false })),
    });
    await waitFor(actor, (s) => s.matches("backingOff"));
    expect(actor.getSnapshot().context.backoffMs).toBe(90_000);
    expect(actor.getSnapshot().context.lastError).toMatch(/rate limit/);
    actor.send({ type: "sync.now" });
    expect(actor.getSnapshot().matches("backingOff")).toBe(true);
    fail = false;
    clock.increment(89_999);
    expect(steps.linear).toHaveBeenCalledOnce();
    clock.increment(1);
    await waitFor(actor, (s) => s.matches("waiting"));
    expect(actor.getSnapshot().context.attempt).toBe(0);
    expect(actor.getSnapshot().context.lastError).toBeNull();
  });

  it("backs off exponentially, capped", () => {
    expect([1, 2, 3].map((a) => backoffFor(timing, a, new Error("x")))).toEqual([30_000, 60_000, 120_000]);
    expect(backoffFor(timing, 20, new Error("x"))).toBe(timing.backoffMaxMs);
  });

  it("wipes on an account change, then starts over", async () => {
    let kind: IdentifyOutput["kind"] = "changed";
    const { actor, steps } = setup({
      identify: () => {
        const out = { kind };
        kind = "same";
        return Promise.resolve(out);
      },
    });
    await waitFor(actor, (s) => s.matches("waiting"));
    expect(steps.wipe).toHaveBeenCalledOnce();
    expect(steps.identify).toHaveBeenCalledTimes(2);
    expect(steps.linear).toHaveBeenCalledOnce();
  });

  it("is off without a Linear key and looks again later or on sync.now", async () => {
    let kind: IdentifyOutput["kind"] = "off";
    const { actor, clock, steps } = setup({ identify: () => Promise.resolve({ kind }) });
    await waitFor(actor, (s) => s.matches("off"));
    expect(steps.linear).not.toHaveBeenCalled();
    expect(actor.getSnapshot().context.lastError).toBe("No Linear key on the host");
    clock.increment(timing.offRetryMs);
    await waitFor(actor, (s) => s.matches("off") && steps.identify.mock.calls.length === 2);
    kind = "same";
    actor.send({ type: "sync.now" });
    await waitFor(actor, (s) => s.matches("waiting"));
  });

  it("refuses nothing it should: off and backingOff take no step events", async () => {
    const { actor } = setup({ identify: () => Promise.reject(new Error("down")) });
    await waitFor(actor, (s) => s.matches("backingOff"));
    expect(actor.getSnapshot().can({ type: "sync.now" })).toBe(false);
  });
});
