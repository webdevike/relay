import { describe, expect, it } from "vitest";
import { createActor, SimulatedClock } from "xstate";
import { cardOpen, composerShapeMachine, OPENING_TIMEOUT_MS, type ComposerShapeEvent } from "./composerShape.machine";
import { composerBusy, subscribeComposerBusy, trackComposer } from "./composerShape";

function start(online = true) {
  const clock = new SimulatedClock();
  const actor = createActor(composerShapeMachine, { clock, input: { online } }).start();
  return {
    actor,
    clock,
    value: () => actor.getSnapshot().value,
    can: (event: ComposerShapeEvent) => actor.getSnapshot().can(event),
  };
}

describe("composerShape", () => {
  it("opens on a tap and becomes typing when the field takes focus", () => {
    const { actor, value } = start();
    actor.send({ type: "composer.tapPill" });
    expect(value()).toBe("opening");
    expect(cardOpen(actor.getSnapshot())).toBe(true);
    actor.send({ type: "composer.focus" });
    expect(value()).toBe("typing");
    actor.send({ type: "composer.blur" });
    expect(value()).toBe("idle");
    expect(cardOpen(actor.getSnapshot())).toBe(false);
  });

  it("falls back to idle when the focus never arrives", () => {
    const { actor, clock, value } = start();
    actor.send({ type: "composer.tapPill" });
    clock.increment(OPENING_TIMEOUT_MS - 1);
    expect(value()).toBe("opening");
    clock.increment(1);
    expect(value()).toBe("idle");
    expect(cardOpen(actor.getSnapshot())).toBe(false);
  });

  it("a focus that lands in time cancels the timeout", () => {
    const { actor, clock, value } = start();
    actor.send({ type: "composer.tapPill" });
    actor.send({ type: "composer.focus" });
    clock.increment(OPENING_TIMEOUT_MS * 2);
    expect(value()).toBe("typing");
  });

  it("refuses a pill tap while typing (no focus event would follow to close `opening`)", () => {
    const { actor, can } = start();
    actor.send({ type: "composer.focus" });
    expect(can({ type: "composer.tapPill" })).toBe(false);
  });

  it("allows typing after a tap dictation stops", () => {
    const { actor, value, can } = start();
    actor.send({ type: "composer.tapPill" });
    actor.send({ type: "composer.tapMic" });
    expect(value()).toBe("tapDictating");
    actor.send({ type: "composer.focus" });
    expect(value()).toBe("tapDictating");
    // One run at a time: no second tap dictation or hold over a running one.
    expect(can({ type: "composer.tapMic" })).toBe(false);
    expect(can({ type: "composer.holdStart" })).toBe(false);
    actor.send({ type: "composer.dictationLanded" });
    expect(value()).toBe("typing");
  });

  it("a dictation that lands with the keyboard down closes to the pill", () => {
    const { actor, value } = start();
    actor.send({ type: "composer.tapMic" });
    actor.send({ type: "composer.dictationLanded" });
    expect(value()).toBe("idle");
  });

  it("keeps the field editable offline: typing survives a drop and opening works without the Mac", () => {
    const { actor, value } = start();
    actor.send({ type: "composer.focus" });
    actor.send({ type: "composer.connection", up: false });
    expect(value()).toBe("typing");
    actor.send({ type: "composer.blur" });
    actor.send({ type: "composer.tapPill" });
    actor.send({ type: "composer.focus" });
    expect(value()).toBe("typing");
  });

  it("refuses the mic and the hold offline", () => {
    const { actor, value, can } = start(false);
    expect(can({ type: "composer.tapMic" })).toBe(false);
    expect(can({ type: "composer.holdStart" })).toBe(false);
    actor.send({ type: "composer.connection", up: true });
    actor.send({ type: "composer.holdStart" });
    expect(value()).toBe("holding");
  });

  it("a hold from the pill keeps it a pill and returns there; from the card it returns to typing", () => {
    const { actor, value } = start();
    actor.send({ type: "composer.holdStart" });
    expect(value()).toBe("holding");
    expect(cardOpen(actor.getSnapshot())).toBe(false);
    actor.send({ type: "composer.holdEnd" });
    expect(value()).toBe("idle");
    actor.send({ type: "composer.focus" });
    actor.send({ type: "composer.holdStart" });
    expect(cardOpen(actor.getSnapshot())).toBe(true);
    actor.send({ type: "composer.holdEnd" });
    expect(value()).toBe("typing");
  });

  it("composerBusy is true while any tracked composer is not idle", () => {
    const a = start();
    const b = start();
    let changes = 0;
    const stopListening = subscribeComposerBusy(() => {
      changes += 1;
    });
    const untrackA = trackComposer(a.actor);
    const untrackB = trackComposer(b.actor);
    expect(composerBusy()).toBe(false);
    b.actor.send({ type: "composer.focus" });
    expect(composerBusy()).toBe(true);
    expect(changes).toBeGreaterThan(0);
    untrackB();
    expect(composerBusy()).toBe(false);
    a.actor.send({ type: "composer.holdStart" });
    expect(composerBusy()).toBe(true);
    untrackA();
    stopListening();
    expect(composerBusy()).toBe(false);
  });
});
