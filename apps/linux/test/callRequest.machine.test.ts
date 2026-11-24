import { describe, expect, it, vi } from "vitest";
import { createActor, fromCallback, fromPromise, SimulatedClock, waitFor } from "xstate";
import { callRequestMachine, type CallRequestEvent, type CallRequestInput, type WorkOutcome } from "../src/callme/callRequest.machine";
import { openerOf } from "../src/callme/service";

const timing = { ringMs: 60_000, maxWaitMs: 3_600_000 };
const input = { id: "call-1", agent: "nova", about: "the waterfall options", timing };

/** The machine with stubbed effects: `settle` sends the work's outcome; every action is a spy. */
function setup(attach: () => Promise<null> = () => Promise.resolve(null)) {
  let send: ((event: CallRequestEvent) => void) | null = null;
  const stopped = vi.fn();
  const actions = {
    announce: vi.fn(),
    ring: vi.fn(),
    markConnected: vi.fn(),
    notifyMissed: vi.fn(),
    markCancelled: vi.fn(),
    markExpired: vi.fn(),
  };
  const machine = callRequestMachine.provide({
    actors: {
      attach: fromPromise(attach),
      watch: fromCallback<CallRequestEvent, CallRequestInput>(({ sendBack }) => {
        send = sendBack;
        return stopped;
      }),
    },
    actions,
  });
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input, clock }).start();
  const settle = (outcome: WorkOutcome): void => {
    if (send === null) throw new Error("not watching");
    send({ type: "work.settled", outcome });
  };
  return { actor, clock, actions, stopped, settle };
}

describe("callRequestMachine", () => {
  it("waits for the work, rings when it finishes and connects when Isaac answers", async () => {
    const { actor, actions, settle } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    expect(actions.announce).toHaveBeenCalledOnce();
    settle({ status: "done", result: "Three options, B is cheapest." });
    expect(actor.getSnapshot().value).toBe("ringing");
    expect(actions.ring).toHaveBeenCalledOnce();
    actor.send({ type: "call.answered" });
    const end = actor.getSnapshot();
    expect(end.value).toBe("connected");
    expect(end.status).toBe("done");
    expect(end.output?.outcome).toEqual({ status: "done", result: "Three options, B is cheapest." });
    expect(actions.markConnected).toHaveBeenCalledOnce();
    expect(actions.notifyMissed).not.toHaveBeenCalled();
  });

  it("is missed when nobody answers within ringMs: one missed-call notice, no retry", async () => {
    const { actor, clock, actions, settle } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    settle({ status: "done", result: "ready" });
    clock.increment(timing.ringMs - 1);
    expect(actor.getSnapshot().value).toBe("ringing");
    clock.increment(1);
    expect(actor.getSnapshot().value).toBe("missed");
    expect(actor.getSnapshot().status).toBe("done");
    clock.increment(10 * timing.ringMs);
    expect(actions.ring).toHaveBeenCalledOnce();
    expect(actions.notifyMissed).toHaveBeenCalledOnce();
    // A late tap on the old notification is an ordinary call, not a connect.
    expect(actor.getSnapshot().can({ type: "call.answered" })).toBe(false);
  });

  it("is cancelled while waiting: stops watching, never rings", async () => {
    const { actor, clock, actions, stopped } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    actor.send({ type: "request.cancel", reason: "never mind" });
    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(actor.getSnapshot().output?.reason).toBe("never mind");
    expect(stopped).toHaveBeenCalledOnce();
    clock.increment(timing.maxWaitMs);
    expect(actions.ring).not.toHaveBeenCalled();
    expect(actions.markCancelled).toHaveBeenCalledOnce();
    expect(actions.markExpired).not.toHaveBeenCalled();
  });

  it("is cancelled while ringing: no missed call follows", async () => {
    const { actor, clock, actions, settle } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    settle({ status: "done", result: "ready" });
    actor.send({ type: "request.cancel" });
    clock.increment(timing.ringMs);
    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(actions.notifyMissed).not.toHaveBeenCalled();
    expect(actions.markCancelled).toHaveBeenCalledOnce();
  });

  it("still rings when the work fails, and the greeting says it did not finish", async () => {
    const { actor, settle } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    settle({ status: "failed", result: '"Waterfall options" timed out.' });
    const ringing = actor.getSnapshot();
    expect(ringing.value).toBe("ringing");
    expect(ringing.context.outcome?.status).toBe("failed");
    const opener = openerOf({ about: input.about, outcome: ringing.context.outcome ?? undefined }, "Isaac");
    expect(opener.greeting).toBe("Hey Isaac, the thing you asked for didn't finish: the waterfall options. Want me to look into it?");
    expect(opener.brief).toContain("timed out");
  });

  it("names the work in the greeting when it finished", () => {
    const opener = openerOf({ about: "the waterfall options", outcome: { status: "done", result: "B wins" } }, "Isaac");
    expect(opener.greeting).toBe("Hey Isaac, the thing you asked for is done: the waterfall options. Want any follow-ups?");
    expect(opener.brief).toContain("B wins");
  });

  it("is rejected when the work it names cannot be found", async () => {
    const { actor, actions } = setup(() => Promise.reject(new Error("no agent-session run x")));
    const end = await waitFor(actor, (s) => s.status === "done");
    expect(end.value).toBe("rejected");
    expect(end.output?.reason).toBe("no agent-session run x");
    expect(actions.announce).not.toHaveBeenCalled();
  });

  it("gives up after maxWaitMs without ringing", async () => {
    const { actor, clock, actions } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    clock.increment(timing.maxWaitMs);
    expect(actor.getSnapshot().value).toBe("expired");
    expect(actions.ring).not.toHaveBeenCalled();
    expect(actions.markExpired).toHaveBeenCalledOnce();
  });

  it("cannot be answered before it rings", async () => {
    const { actor } = setup();
    await waitFor(actor, (s) => s.matches("waiting"));
    expect(actor.getSnapshot().can({ type: "call.answered" })).toBe(false);
  });
});
