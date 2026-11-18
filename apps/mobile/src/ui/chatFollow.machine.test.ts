import { describe, expect, it } from "vitest";
import { createActor, SimulatedClock } from "xstate";
import { awayFromBottom, BOTTOM_THRESHOLD, chatFollowMachine, RETURN_TIMEOUT_MS } from "./chatFollow.machine";

function start(initialOffset = 0) {
  const effects: string[] = [];
  const clock = new SimulatedClock();
  const machine = chatFollowMachine.provide({
    actions: {
      followNewest: () => {
        effects.push("followNewest");
      },
      scrollHome: ({ event }) => {
        effects.push(event.type === "follow.toBottom" && event.animated ? "scrollHome animated" : "scrollHome");
      },
      centreRow: ({ event }) => {
        if (event.type === "follow.toRow") effects.push(`centreRow ${event.index}`);
      },
    },
  });
  const actor = createActor(machine, { clock, input: { initialOffset } }).start();
  return { actor, clock, effects, value: () => actor.getSnapshot().value, away: () => awayFromBottom(actor.getSnapshot()) };
}

describe("chatFollow", () => {
  it("starts following at the bottom and reading away from it", () => {
    expect(start(0).value()).toBe("following");
    const away = start(400);
    expect(away.value()).toEqual({ reading: "still" });
    expect(away.away()).toBe(true);
  });

  it("follows new content only while following", () => {
    const { actor, effects } = start();
    actor.send({ type: "follow.contentChanged" });
    expect(effects).toEqual(["followNewest"]);
    actor.send({ type: "follow.dragStart" });
    expect(actor.getSnapshot().can({ type: "follow.contentChanged" })).toBe(false);
  });

  it("a drag goes to reading, and away from the bottom stays there", () => {
    const { actor, value, away } = start();
    actor.send({ type: "follow.dragStart" });
    expect(value()).toEqual({ reading: "moving" });
    expect(away()).toBe(false);
    actor.send({ type: "follow.scroll", offset: 300 });
    expect(away()).toBe(true);
    actor.send({ type: "follow.dragEnd", offset: 320 });
    expect(value()).toEqual({ reading: "still" });
    // Native anchoring moves the offset while still: the machine refuses to read it.
    expect(actor.getSnapshot().can({ type: "follow.scroll", offset: 5 })).toBe(false);
  });

  it("refuses offsets while following, so anchoring never unpins a follower", () => {
    const { actor } = start();
    expect(actor.getSnapshot().can({ type: "follow.scroll", offset: 400 })).toBe(false);
  });

  it("scrolling back near the bottom follows again", () => {
    const { actor, value, away } = start(500);
    actor.send({ type: "follow.dragStart" });
    actor.send({ type: "follow.scroll", offset: 100 });
    actor.send({ type: "follow.dragEnd", offset: BOTTOM_THRESHOLD });
    expect(value()).toBe("following");
    expect(away()).toBe(false);
  });

  it("a flick that lands near the bottom follows and catches up", () => {
    const { actor, value, effects } = start(500);
    actor.send({ type: "follow.dragStart" });
    actor.send({ type: "follow.dragEnd", offset: 200 });
    actor.send({ type: "follow.momentumStart" });
    expect(value()).toEqual({ reading: "moving" });
    actor.send({ type: "follow.momentumEnd", offset: 0 });
    expect(value()).toBe("following");
    expect(effects).toEqual(["followNewest"]);
  });

  it("returning with no end event recovers to following", () => {
    const { actor, clock, value, effects, away } = start(500);
    actor.send({ type: "follow.toBottom", animated: true });
    expect(value()).toBe("returning");
    expect(away()).toBe(false);
    // Rows that arrive on the way wait for the landing.
    expect(actor.getSnapshot().can({ type: "follow.contentChanged" })).toBe(false);
    clock.increment(RETURN_TIMEOUT_MS - 1);
    expect(value()).toBe("returning");
    clock.increment(1);
    expect(value()).toBe("following");
    expect(effects).toEqual(["scrollHome animated", "followNewest"]);
  });

  it("returning ends on the momentum end when it comes", () => {
    const { actor, clock, value, effects } = start(500);
    actor.send({ type: "follow.toBottom", animated: true });
    actor.send({ type: "follow.momentumEnd", offset: 0 });
    expect(value()).toBe("following");
    clock.increment(RETURN_TIMEOUT_MS);
    expect(effects).toEqual(["scrollHome animated", "followNewest"]);
  });

  it("a second tap home restarts the deadline", () => {
    const { actor, clock, value } = start(500);
    actor.send({ type: "follow.toBottom", animated: true });
    clock.increment(RETURN_TIMEOUT_MS - 100);
    actor.send({ type: "follow.toBottom", animated: true });
    clock.increment(200);
    expect(value()).toBe("returning");
    clock.increment(RETURN_TIMEOUT_MS);
    expect(value()).toBe("following");
  });

  it("a drag while returning hands control to the reader", () => {
    const { actor, clock, value } = start(500);
    actor.send({ type: "follow.toBottom", animated: true });
    actor.send({ type: "follow.dragStart" });
    clock.increment(RETURN_TIMEOUT_MS);
    expect(value()).toEqual({ reading: "moving" });
  });

  it("with reduced motion, home is a jump straight to following", () => {
    const { actor, value, effects } = start(500);
    actor.send({ type: "follow.toBottom", animated: false });
    expect(value()).toBe("following");
    expect(effects).toEqual(["scrollHome"]);
  });

  it("centring a row stops following and remembers the row", () => {
    const { actor, value, effects, away } = start();
    actor.send({ type: "follow.toRow", index: 12, animated: true });
    expect(value()).toBe("centring");
    expect(actor.getSnapshot().context.target).toBe(12);
    expect(away()).toBe(true);
    expect(actor.getSnapshot().can({ type: "follow.contentChanged" })).toBe(false);
    expect(actor.getSnapshot().can({ type: "follow.toRow", index: -1, animated: true })).toBe(false);
    expect(effects).toEqual(["centreRow 12"]);
    actor.send({ type: "follow.dragStart" });
    expect(value()).toEqual({ reading: "moving" });
  });
});
