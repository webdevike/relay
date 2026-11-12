import { describe, expect, it, vi } from "vitest";
import { SimulatedClock, createActor } from "xstate";
import { UNDO_MS, cardUndoMachine } from "./cardUndo.machine";

function harness() {
  const restore = vi.fn();
  const clock = new SimulatedClock();
  const machine = cardUndoMachine.provide({
    actions: {
      restore: ({ context }) => {
        restore(context.key);
      },
    },
  });
  const actor = createActor(machine, { clock }).start();
  return { actor, clock, restore, value: () => actor.getSnapshot().value };
}

describe("cardUndoMachine", () => {
  it("offers Undo for UNDO_MS after a dismissal, then lets go without restoring", () => {
    const { actor, clock, restore, value } = harness();
    expect(value()).toBe("idle");
    actor.send({ type: "card.dismissed", key: "canvas:m1", message: "Dismissed: Join Nova" });
    expect(value()).toBe("offering");
    expect(actor.getSnapshot().context.message).toBe("Dismissed: Join Nova");
    clock.increment(UNDO_MS - 1);
    expect(value()).toBe("offering");
    clock.increment(1);
    expect(value()).toBe("idle");
    expect(restore).not.toHaveBeenCalled();
  });

  it("Undo restores exactly the dismissed entry and closes the offer", () => {
    const { actor, restore, value } = harness();
    actor.send({ type: "card.dismissed", key: "work:w1#running", message: "Dismissed" });
    actor.send({ type: "card.undo" });
    expect(restore).toHaveBeenCalledExactlyOnceWith("work:w1#running");
    expect(value()).toBe("idle");
  });

  it("a second dismissal replaces the offer and restarts the timer; Undo then restores the newest", () => {
    const { actor, clock, restore, value } = harness();
    actor.send({ type: "card.dismissed", key: "a", message: "A" });
    clock.increment(UNDO_MS - 500);
    actor.send({ type: "card.dismissed", key: "b", message: "B" });
    clock.increment(UNDO_MS - 1);
    expect(value()).toBe("offering");
    actor.send({ type: "card.undo" });
    expect(restore).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("refuses Undo when nothing is on offer", () => {
    const { actor, restore } = harness();
    expect(actor.getSnapshot().can({ type: "card.undo" })).toBe(false);
    actor.send({ type: "card.undo" });
    expect(restore).not.toHaveBeenCalled();
  });
});
