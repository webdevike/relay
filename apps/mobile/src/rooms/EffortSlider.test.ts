import { describe, expect, it } from "vitest";
import { stopAt } from "./model";

describe("stopAt", () => {
  const width = 340;
  const inset = 20;
  it("lands on the stop nearest the finger, clamped to the ends", () => {
    expect(stopAt(-50, width, 6, inset)).toBe(1);
    expect(stopAt(20, width, 6, inset)).toBe(1);
    expect(stopAt(width - 20, width, 6, inset)).toBe(6);
    expect(stopAt(900, width, 6, inset)).toBe(6);
  });
  it("switches halfway between two stops", () => {
    // Stops are 60pt apart (span 300 over 5 gaps); the midpoint of 1 and 2 is 20 + 30.
    expect(stopAt(49, width, 6, inset)).toBe(1);
    expect(stopAt(51, width, 6, inset)).toBe(2);
  });
  it("does not divide by zero before it is laid out", () => {
    expect(stopAt(10, 0, 6, inset)).toBe(1);
  });
});
