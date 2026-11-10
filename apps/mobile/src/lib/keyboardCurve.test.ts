import { describe, expect, it } from "vitest";
import { keyboardClosing, keyboardHeightAt, keyboardOpening, keyboardOpenness } from "./keyboardCurve";

const steps = Array.from({ length: 101 }, (_, index) => index / 100);

describe("keyboard curves", () => {
  for (const [name, curve] of [
    ["opening", keyboardOpening],
    ["closing", keyboardClosing],
  ] as const) {
    it(`${name} runs 0 to 1 without ever stepping back (a reversal would shake the composer)`, () => {
      expect(curve(0)).toBeCloseTo(0, 6);
      expect(curve(1)).toBeCloseTo(1, 6);
      let last = -Infinity;
      for (const x of steps) {
        const now = curve(x);
        expect(now).toBeGreaterThanOrEqual(last);
        expect(now).toBeLessThanOrEqual(1);
        last = now;
      }
    });

    it(`${name} holds its ends outside 0 to 1`, () => {
      expect(curve(-0.5)).toBeCloseTo(0, 6);
      expect(curve(1.5)).toBeCloseTo(1, 6);
    });
  }

  it("starts fast and lands softly, as the keyboard does", () => {
    expect(keyboardOpening(0.25)).toBeGreaterThan(0.6);
    expect(keyboardOpening(0.9) - keyboardOpening(0.8)).toBeLessThan(0.02);
  });
});

describe("keyboardOpenness", () => {
  it("is the share of the open height, clamped, and 0 before any keyboard", () => {
    expect(keyboardOpenness(168, 336)).toBe(0.5);
    expect(keyboardOpenness(346, 336)).toBe(1);
    expect(keyboardOpenness(-4, 336)).toBe(0);
    expect(keyboardOpenness(100, 0)).toBe(0);
  });
});

describe("keyboardHeightAt", () => {
  it("measures from the window's bottom and is 0 off screen", () => {
    expect(keyboardHeightAt(516, 852)).toBe(336);
    expect(keyboardHeightAt(852, 852)).toBe(0);
    expect(keyboardHeightAt(900, 852)).toBe(0);
  });
});
