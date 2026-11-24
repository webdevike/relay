import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { cardStackMachine } from "./cardStack.machine";

const start = (ids: readonly string[] = []) => createActor(cardStackMachine, { input: { loop: true, ids } }).start();

describe("card stack machine (phone)", () => {
  it("has no tab without cards and cannot open; the first card arriving shows the tab", () => {
    const stack = start();
    expect(stack.getSnapshot().value).toBe("empty");
    expect(stack.getSnapshot().can({ type: "stack.open" })).toBe(false);
    stack.send({ type: "cards.changed", ids: ["ask:1", "run:1"] });
    expect(stack.getSnapshot().value).toBe("collapsed");
    expect(stack.getSnapshot().context.front).toBe("ask:1");
  });

  it("loops the carousel both ways and cannot swipe while collapsed", () => {
    const stack = start(["a", "b", "c"]);
    expect(stack.getSnapshot().can({ type: "stack.step", by: 1 })).toBe(false);
    stack.send({ type: "stack.open" });
    stack.send({ type: "stack.step", by: -1 });
    expect(stack.getSnapshot().context).toMatchObject({ front: "c", dir: -1 });
    stack.send({ type: "stack.step", by: 1 });
    expect(stack.getSnapshot().context.front).toBe("a");
  });

  it("an answered card leaves for the next one; the last one leaving closes the carousel", () => {
    const stack = start(["a", "b"]);
    stack.send({ type: "stack.open", id: "a" });
    stack.send({ type: "card.answered", id: "a" });
    expect(stack.getSnapshot().context.answered).toBe("a");
    stack.send({ type: "cards.changed", ids: ["b"] });
    expect(stack.getSnapshot().context).toMatchObject({ front: "b", answered: null });
    expect(stack.getSnapshot().value).toBe("expanded");
    stack.send({ type: "cards.changed", ids: [] });
    expect(stack.getSnapshot().value).toBe("empty");
  });
});
