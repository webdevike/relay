import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { audioOwnerMachine } from "./audioOwner.machine";

function harness() {
  const state = { handedBack: 0 };
  const actor = createActor(
    audioOwnerMachine.provide({
      actions: {
        handBack: () => {
          state.handedBack += 1;
        },
      },
    }),
  ).start();
  return {
    actor,
    get handedBack() {
      return state.handedBack;
    },
    owner: () => actor.getSnapshot().value,
    calls: (liveCall: boolean, legacyCall: boolean) => {
      actor.send({ type: "calls.changed", liveCall, legacyCall });
    },
  };
}

describe("audioOwnerMachine", () => {
  it("dictation owns the session from its start and hands it back at its end", () => {
    const h = harness();
    expect(h.owner()).toBe("none");
    h.actor.send({ type: "dictation.started" });
    expect(h.owner()).toBe("dictation");
    h.actor.send({ type: "dictation.ended" });
    expect(h.owner()).toBe("none");
    expect(h.handedBack).toBe(1);
  });

  it("an end without a claim hands nothing back", () => {
    const h = harness();
    expect(h.actor.getSnapshot().can({ type: "dictation.ended" })).toBe(false);
    h.actor.send({ type: "dictation.ended" });
    expect(h.handedBack).toBe(0);
  });

  it("dictation ending while a live call owns the session does not release it (liveCallUp)", () => {
    const h = harness();
    h.actor.send({ type: "dictation.started" });
    h.calls(true, false);
    expect(h.owner()).toBe("liveCall");
    h.actor.send({ type: "dictation.ended" });
    expect(h.owner()).toBe("liveCall");
    expect(h.handedBack).toBe(0);
    // The call ending later finds no dictation to hand the session back for (liveCallDown).
    h.calls(false, false);
    expect(h.owner()).toBe("none");
    expect(h.handedBack).toBe(0);
  });

  it("a dictation started during a legacy call never releases it (legacyCallUp)", () => {
    const h = harness();
    h.calls(false, true);
    h.actor.send({ type: "dictation.started" });
    expect(h.owner()).toBe("legacyCall");
    h.actor.send({ type: "dictation.ended" });
    expect(h.handedBack).toBe(0);
  });

  it("a dictation outliving the legacy call gets the session back and releases it (legacyCallDown, dictating)", () => {
    const h = harness();
    h.actor.send({ type: "dictation.started" });
    h.calls(false, true);
    h.calls(false, false);
    expect(h.owner()).toBe("dictation");
    h.actor.send({ type: "dictation.ended" });
    expect(h.handedBack).toBe(1);
  });

  it("the live call outranks the legacy call, which owns it again when the live call ends", () => {
    const h = harness();
    h.calls(false, true);
    expect(h.owner()).toBe("legacyCall");
    h.calls(true, true);
    expect(h.owner()).toBe("liveCall");
    h.calls(false, true);
    expect(h.owner()).toBe("legacyCall");
    h.calls(false, false);
    expect(h.owner()).toBe("none");
  });
});
