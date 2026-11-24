import { describe, expect, it } from "vitest";
import { carouselCardWidth, carouselOwner, carouselRelease, loopSlot, sideness } from "./carouselMath";

describe("carouselCardWidth", () => {
  it("leaves 36 pt each side for the neighbours, never narrower than 220", () => {
    expect(carouselCardWidth(390)).toBe(318);
    expect(carouselCardWidth(250)).toBe(220);
  });
});

describe("loopSlot", () => {
  it("puts the front card in the middle and its neighbours either side", () => {
    expect([0, 1, 2, 3, 4].map((index) => loopSlot(index, 0, 5))).toEqual([0, 1, 2, -2, -1]);
  });

  it("loops: past the last card comes the first, before the first the last", () => {
    expect(loopSlot(0, 4, 5)).toBe(1);
    expect(loopSlot(4, 0, 5)).toBe(-1);
  });

  it("keeps the other of two cards on the right, and one card alone in front", () => {
    expect(loopSlot(1, 0, 2)).toBe(1);
    expect(loopSlot(0, 1, 2)).toBe(1);
    expect(loopSlot(0, 0, 1)).toBe(0);
    expect(loopSlot(0, 0, 0)).toBe(0);
  });
});

describe("sideness", () => {
  it("is 0 in front, 1 one card away and beyond, in between while dragged", () => {
    expect(sideness(0, 330)).toBe(0);
    expect(sideness(-165, 330)).toBe(0.5);
    expect(sideness(330, 330)).toBe(1);
    expect(sideness(990, 330)).toBe(1);
    expect(sideness(100, 0)).toBe(0);
  });
});

describe("carouselOwner", () => {
  it("waits for the slop, then takes sideways and downward swipes and leaves upward ones", () => {
    expect(carouselOwner(4, 6)).toBe("undecided");
    expect(carouselOwner(-14, 3)).toBe("carousel");
    expect(carouselOwner(3, 14)).toBe("carousel");
    expect(carouselOwner(3, -14)).toBe("none");
  });
});

describe("carouselRelease", () => {
  it("moves one card past 60 pt sideways: left brings the next, right the previous", () => {
    expect(carouselRelease(-61, 0, 0, 0)).toBe(1);
    expect(carouselRelease(61, 0, 0, 0)).toBe(-1);
    expect(carouselRelease(-40, 0, 0, 0)).toBe(0);
  });

  it("counts a quick flick as a longer drag", () => {
    expect(carouselRelease(-20, 0, -400, 0)).toBe(1);
    expect(carouselRelease(20, 0, 400, 0)).toBe(-1);
  });

  it("collapses on a mostly downward release past 90 pt, flicks included, and springs back short of it", () => {
    expect(carouselRelease(0, 91, 0, 0)).toBe("collapse");
    expect(carouselRelease(0, 40, 0, 400)).toBe("collapse");
    expect(carouselRelease(0, 80, 0, 0)).toBe(0);
    expect(carouselRelease(20, 80, 0, 0)).toBe(0);
    expect(carouselRelease(0, -120, 0, 0)).toBe(0);
  });
});
