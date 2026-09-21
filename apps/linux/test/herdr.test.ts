import { describe, expect, it } from "bun:test";
import { planSplit } from "../src/agents/herdr";

const pane = (pane_id: string, width: number, height: number) => ({ pane_id, rect: { width, height } });

describe("planSplit", () => {
  it("splits the largest pane, to the right when it is wide", () => {
    expect(planSplit([pane("a", 60, 40), pane("b", 200, 60)])).toEqual({ pane_id: "b", direction: "right" });
  });

  it("splits a tall pane down", () => {
    expect(planSplit([pane("a", 120, 75)])).toEqual({ pane_id: "a", direction: "down" });
  });

  it("prefers right over down when only the width can afford a split", () => {
    expect(planSplit([pane("a", 160, 30)])).toEqual({ pane_id: "a", direction: "right" });
  });

  it("refuses when even the largest pane would leave unusable halves", () => {
    expect(planSplit([pane("a", 100, 30), pane("b", 80, 20)])).toBeNull();
    expect(planSplit([])).toBeNull();
  });
});
