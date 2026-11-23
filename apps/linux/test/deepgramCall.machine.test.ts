import { describe, expect, it } from "vitest";
import { createActor, fromCallback, SimulatedClock } from "xstate";
import { MAX_LIVE_CALL_MS } from "@relay/protocol";
import { deepgramCallMachine, type DeepgramCallEvent } from "../src/call/deepgramCall.machine";

/** The machine with a session stub that counts its starts and cleanups. */
function harness() {
  const clock = new SimulatedClock();
  const counts = { started: 0, cleaned: 0 };
  const machine = deepgramCallMachine.provide({
    actors: {
      session: fromCallback<DeepgramCallEvent>(() => {
        counts.started += 1;
        return () => {
          counts.cleaned += 1;
        };
      }),
    },
  });
  const actor = createActor(machine, { clock });
  actor.start();
  const live = (): string => JSON.stringify(actor.getSnapshot().value);
  return { actor, clock, counts, live };
}

function connected() {
  const h = harness();
  h.actor.send({ type: "session.ready" });
  return h;
}

describe("deepgramCall machine", () => {
  it("follows the call from connecting through every phone-visible state", () => {
    const h = harness();
    expect(h.live()).toBe('"connecting"');
    h.actor.send({ type: "session.ready" });
    expect(h.live()).toBe('{"live":"listening"}');
    h.actor.send({ type: "user.speaking" });
    expect(h.live()).toBe('{"live":"hearing"}');
    h.actor.send({ type: "question.asked" });
    expect(h.live()).toBe('{"live":"thinking"}');
    h.actor.send({ type: "agent.speaking" });
    expect(h.live()).toBe('{"live":"speaking"}');
    h.actor.send({ type: "user.speaking" });
    expect(h.live()).toBe('{"live":"hearing"}');
    h.actor.send({ type: "agent.done" });
    expect(h.live()).toBe('{"live":"listening"}');
  });

  it("is unavailable, not ended, when the session never opens", () => {
    const h = harness();
    h.actor.send({ type: "session.failed", reason: "Deepgram connection failed" });
    expect(h.live()).toBe('"unavailable"');
    expect(h.actor.getSnapshot().output).toEqual({ connected: false, error: "Deepgram connection failed" });
    expect(h.counts).toEqual({ started: 1, cleaned: 1 });
  });

  it("refuses speech events before the session is ready", () => {
    const h = harness();
    expect(h.actor.getSnapshot().can({ type: "user.speaking" })).toBe(false);
    expect(h.actor.getSnapshot().can({ type: "question.asked" })).toBe(false);
    h.actor.send({ type: "user.speaking" });
    expect(h.live()).toBe('"connecting"');
  });

  it.each<[string, DeepgramCallEvent, string | null]>([
    ["hang-up", { type: "call.hangup", reason: "phone: done" }, "phone: done"],
    ["hang-up without a reason", { type: "call.hangup" }, null],
    ["socket loss", { type: "session.closed", reason: "Deepgram dropped the call" }, "Deepgram dropped the call"],
    ["provider failure", { type: "session.failed", reason: "FAILED_TO_THINK" }, "FAILED_TO_THINK"],
  ])("ends once and closes the session on %s", (_name, event, error) => {
    const h = connected();
    h.actor.send({ type: "question.asked" });
    h.actor.send(event);
    expect(h.live()).toBe('"ended"');
    expect(h.actor.getSnapshot().output).toEqual({ connected: true, error });
    h.actor.send({ type: "call.hangup" });
    h.actor.send({ type: "session.closed", reason: "late" });
    expect(h.actor.getSnapshot().output).toEqual({ connected: true, error });
    expect(h.counts).toEqual({ started: 1, cleaned: 1 });
  });

  it("ends at the call cap, not before, and closes the session", () => {
    const h = connected();
    h.clock.increment(MAX_LIVE_CALL_MS - 1);
    expect(h.live()).toBe('{"live":"listening"}');
    h.clock.increment(1);
    expect(h.live()).toBe('"ended"');
    expect(h.actor.getSnapshot().output?.error).toBe("The call reached its time limit");
    expect(h.counts.cleaned).toBe(1);
  });

  it("ends a call hung up while connecting", () => {
    const h = harness();
    h.actor.send({ type: "call.hangup", reason: "phone: gave up" });
    expect(h.live()).toBe('"ended"');
    expect(h.actor.getSnapshot().output).toEqual({ connected: false, error: "phone: gave up" });
    expect(h.counts.cleaned).toBe(1);
  });
});
