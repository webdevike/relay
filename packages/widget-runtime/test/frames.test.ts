import { describe, expect, it } from "vitest";
import { FRAME_PRESETS, frameOf, frameRefusal, parseFrame } from "../src/systems";

describe("component card frames", () => {
  it("reads a preset or a custom size within bounds, and nothing else", () => {
    expect(parseFrame("page")).toEqual({ preset: "page", label: "Page", w: 1120, h: 684 });
    expect(parseFrame("1200x760")).toEqual({ preset: "custom", label: "Custom", w: 1200, h: 760 });
    for (const bad of [
      "119x400",
      "400x23",
      "3841x400",
      "400x2401",
      "1200 x 760",
      "PAGE",
      "toString",
      "",
    ])
      expect(parseFrame(bad)).toBeNull();
  });

  it("gives a card that names none the desktop window, which it filled before frames", () => {
    expect(frameOf(undefined)).toEqual({ preset: "window", ...FRAME_PRESETS.window });
  });

  it("refuses a missing or unknown frame with every preset and its size", () => {
    expect(frameRefusal("chips")).toBeNull();
    expect(frameRefusal(undefined)).toMatch(/^a component card needs data.frame/);
    expect(frameRefusal("tv")).toMatch(
      /^frame "tv" is not a preset or <w>x<h> \(120-3840 by 24-2400\)/,
    );
    for (const [id, f] of Object.entries(FRAME_PRESETS))
      expect(frameRefusal("tv")).toContain(`${id} (${f.label}, ${String(f.w)}x${String(f.h)})`);
  });
});
