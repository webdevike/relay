import { describe, expect, it } from "vitest";
import { stepAt, stepX } from "./sliderMath";

describe("stepAt", () => {
  it("clamps outside the track", () => {
    expect(stepAt(-30, 250, 6)).toBe(0);
    expect(stepAt(400, 250, 6)).toBe(5);
  });

  it("lands on each step's own position", () => {
    for (let i = 0; i < 6; i++) expect(stepAt(stepX(i, 250, 6), 250, 6)).toBe(i);
  });

  it("rounds to the nearest step around a midpoint", () => {
    // Steps are 50 apart: the midpoint of 0 and 1 is 25.
    expect(stepAt(24.9, 250, 6)).toBe(0);
    expect(stepAt(25.1, 250, 6)).toBe(1);
  });

  it("has only step 0 when there is one step", () => {
    expect(stepAt(120, 250, 1)).toBe(0);
    expect(stepAt(-5, 250, 1)).toBe(0);
    expect(stepX(0, 250, 1)).toBe(0);
  });

  it("survives an unmeasured track", () => {
    expect(stepAt(10, 0, 6)).toBe(0);
  });
});

describe("stepX", () => {
  it("spans the track evenly", () => {
    expect(stepX(0, 250, 6)).toBe(0);
    expect(stepX(1, 250, 6)).toBe(50);
    expect(stepX(5, 250, 6)).toBe(250);
  });
});
