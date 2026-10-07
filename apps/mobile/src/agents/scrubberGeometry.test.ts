import { describe, expect, it } from "vitest";
import {
  EDGE_SPEED,
  EDGE_ZONE,
  MIN_SLOT,
  MIN_THUMB,
  TRACK_PADDING,
  contentWidth,
  edgeScroll,
  maxOffset,
  revealOffset,
  slotAt,
  slotWidthFor,
  thumbSpan,
} from "./scrubberGeometry";

const TRACK = 300;

describe("slotWidthFor", () => {
  it("shares the track evenly while every slot fits a padded thumb", () => {
    expect(slotWidthFor(TRACK, 3)).toBe(100);
  });
  it("keeps the content exactly track-wide between that and the minimum slot", () => {
    const slot = slotWidthFor(TRACK, 6);
    expect(slot).toBeGreaterThan(MIN_SLOT);
    expect(contentWidth(slot, 6)).toBeCloseTo(TRACK);
  });
  it("stops at the minimum slot once sessions outgrow the track", () => {
    expect(slotWidthFor(TRACK, 30)).toBe(MIN_SLOT);
  });
});

describe("thumbSpan", () => {
  it("fills a wide slot minus padding", () => {
    expect(thumbSpan(1, 100)).toEqual({ x: 104, width: 92 });
  });
  it("never narrows below MIN_THUMB on a narrow slot", () => {
    expect(thumbSpan(5, MIN_SLOT).width).toBe(MIN_THUMB);
  });
  it("is centred on its dot at both ends, with padding to the content edge", () => {
    for (const count of [6, 9, 30]) {
      const slot = slotWidthFor(TRACK, count);
      const first = thumbSpan(0, slot);
      const last = thumbSpan(count - 1, slot);
      expect(first.x).toBeCloseTo(TRACK_PADDING);
      expect(last.x + last.width).toBeCloseTo(contentWidth(slot, count) - TRACK_PADDING);
    }
  });
});

describe("slotAt", () => {
  it("maps content positions to slots, clamped to the ends", () => {
    const slot = MIN_SLOT;
    const { x, width } = thumbSpan(3, slot);
    expect(slotAt(x + width / 2, slot, 30)).toBe(3);
    expect(slotAt(-50, slot, 30)).toBe(0);
    expect(slotAt(10_000, slot, 30)).toBe(29);
  });
});

describe("maxOffset", () => {
  it("is zero while the content fits and the overflow once it doesn't", () => {
    expect(maxOffset(TRACK, 100, 3)).toBe(0);
    expect(maxOffset(TRACK, MIN_SLOT, 30)).toBe(contentWidth(MIN_SLOT, 30) - TRACK);
  });
});

describe("revealOffset", () => {
  const count = 30;
  it("leaves the offset alone when the thumb is already visible", () => {
    expect(revealOffset(100, 4, MIN_SLOT, count, TRACK)).toBe(100);
  });
  it("scrolls the end slots fully home so their thumb clears the rounded ends", () => {
    expect(revealOffset(200, 0, MIN_SLOT, count, TRACK)).toBe(0);
    expect(revealOffset(0, count - 1, MIN_SLOT, count, TRACK)).toBe(maxOffset(TRACK, MIN_SLOT, count));
  });
  it("brings an off-screen thumb in with its padding", () => {
    const offset = revealOffset(0, 10, MIN_SLOT, count, TRACK);
    const { x, width } = thumbSpan(10, MIN_SLOT);
    expect(x + width + TRACK_PADDING - offset).toBe(TRACK);
  });
  it("clamps to the content after sessions disappear", () => {
    expect(revealOffset(900, 2, 100, 3, TRACK)).toBe(0);
  });
});

describe("edgeScroll", () => {
  const max = 900;
  it("does nothing outside the end zones or when nothing overflows", () => {
    expect(edgeScroll(100, TRACK / 2, TRACK, max, 1)).toBe(100);
    expect(edgeScroll(0, TRACK, TRACK, 0, 1)).toBe(0);
  });
  it("ramps with depth into the zone and caps at full speed past the end", () => {
    expect(edgeScroll(100, TRACK - EDGE_ZONE / 2, TRACK, max, 1)).toBe(100 + EDGE_SPEED / 2);
    expect(edgeScroll(100, TRACK + 200, TRACK, max, 1)).toBe(100 + EDGE_SPEED);
    expect(edgeScroll(500, -200, TRACK, max, 1)).toBe(500 - EDGE_SPEED);
  });
  it("stops at either end of the content", () => {
    expect(edgeScroll(max - 1, TRACK, TRACK, max, 1)).toBe(max);
    expect(edgeScroll(1, 0, TRACK, max, 1)).toBe(0);
  });
});
