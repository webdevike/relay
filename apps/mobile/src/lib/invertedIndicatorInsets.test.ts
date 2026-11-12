import { describe, expect, it } from "vitest";
import { invertedIndicatorInsets } from "./invertedIndicatorInsets";

describe("invertedIndicatorInsets", () => {
  it("puts what covers the visual bottom in UIKit's top inset, and the visual top in its bottom inset", () => {
    // Header (with chips) 160 + keyboard 0 over the list; composer stack 90 under it.
    expect(invertedIndicatorInsets(160, 90)).toEqual({ top: 90, bottom: 160 });
  });

  it("at offset 0 the indicator's end sits at the composer's top edge, not a header's height above it", () => {
    const frame = 800;
    const header = 160;
    const composer = 90;
    const insets = invertedIndicatorInsets(header, composer);
    // Flipped: native top is the visual bottom, so the track's visual bottom is frame - insets.top.
    const visualBottomOfTrack = frame - insets.top;
    const visualTopOfTrack = insets.bottom;
    expect(visualBottomOfTrack).toBe(frame - composer);
    expect(visualTopOfTrack).toBe(header);
  });
});
