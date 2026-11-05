import { describe, expect, it } from "vitest";
import type { Turn } from "@evaos/chat-core/turns";
import { FILTER_ROOM, MAX_SHARE, TICK_PITCH, cardTop, railView, slotsFor, tickLength, viewableRange } from "./rail";

const turns = (n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ key: `user@${String(i)}`, row: `u${String(i)}`, item: i * 2, led: "user" as const, title: "", reply: "", flag: null }));

describe("slotsFor", () => {
  it("fits ticks in the share of the area the rail may take, at least one", () => {
    expect(slotsFor(600)).toBe(Math.floor((600 * MAX_SHARE - FILTER_ROOM) / TICK_PITCH));
    expect(slotsFor(10)).toBe(1);
    expect(slotsFor(0)).toBe(1);
  });
});

describe("tickLength", () => {
  it("makes the turn on screen the longest", () => {
    expect(tickLength("active")).toBeGreaterThan(tickLength("visible"));
    expect(tickLength("visible")).toBeGreaterThan(tickLength("idle"));
  });
});

describe("viewableRange", () => {
  it("turns the inverted list's indices (0 = newest) into chronological row positions", () => {
    expect(viewableRange([2, 3, 4], 10)).toEqual({ top: 5, bottom: 7 });
    expect(viewableRange([0], 10)).toEqual({ top: 9, bottom: 9 });
  });
  it("is null with nothing on screen or no rows", () => {
    expect(viewableRange([], 10)).toBeNull();
    expect(viewableRange([0], 0)).toBeNull();
  });
});

describe("railView", () => {
  const shown = turns(10);
  it("puts a reader following the newest message in the last turn", () => {
    expect(railView(shown, { top: 4, bottom: 19 }, true)).toEqual({ active: 9, range: [2, 9] });
    expect(railView(shown, null, true)).toEqual({ active: 9, range: [9, 9] });
  });
  it("puts a reader elsewhere in the turn of the topmost row, spanning the turns on screen", () => {
    // Rows 5 and 6 belong to turn 2 (rows 4, 5); row 11 to turn 5.
    expect(railView(shown, { top: 5, bottom: 11 }, false)).toEqual({ active: 2, range: [2, 5] });
    expect(railView(shown, { top: 0, bottom: 1 }, false)).toEqual({ active: 0, range: [0, 0] });
  });
  it("copes with no rows known and with no turns", () => {
    expect(railView(shown, null, false)).toEqual({ active: 9, range: [9, 9] });
    expect(railView([], null, true)).toEqual({ active: 0, range: [0, 0] });
  });
});

describe("cardTop", () => {
  it("centres the card on the finger and keeps it inside the area", () => {
    expect(cardTop(200, 80, 0, 600, 8)).toBe(160);
    expect(cardTop(10, 80, 0, 600, 8)).toBe(8);
    expect(cardTop(590, 80, 0, 600, 8)).toBe(512);
    expect(cardTop(50, 700, 0, 600, 8)).toBe(8);
  });
});
