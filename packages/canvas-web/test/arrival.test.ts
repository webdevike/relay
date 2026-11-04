import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArrivalStore,
  ArrivalTracker,
  MIN_SKELETON_MS,
  READY_TIMEOUT_MS,
  REVEAL_MS,
  TYPE_MS,
  typedLength,
} from "../src/arrival";

describe("added while watching vs initial sync", () => {
  it("nothing animates before the board has synced", () => {
    const t = new ArrivalTracker();
    expect(t.observe(["a", "b"])).toEqual([]);
    t.baseline(["a", "b"]);
    expect(t.observe(["a", "b"])).toEqual([]);
  });

  it("the cards the board opened with never animate, later ones do", () => {
    const t = new ArrivalTracker();
    t.baseline(["a", "b"]);
    expect(t.observe(["a", "b", "c"])).toEqual(["c"]);
    // Seen once: a re-read does not animate it again.
    expect(t.observe(["a", "b", "c"])).toEqual([]);
  });

  it("cards that stream in during the initial sync are part of the baseline", () => {
    const t = new ArrivalTracker();
    // The doc applies the sync step (observed while disarmed), then `sync` fires and arms.
    t.observe(["a"]);
    t.observe(["a", "b"]);
    t.baseline(["a", "b"]);
    expect(t.observe(["a", "b"])).toEqual([]);
  });

  it("a resync after a disconnect does not replay what was missed", () => {
    const t = new ArrivalTracker();
    t.baseline(["a"]);
    t.disarm();
    expect(t.observe(["a", "missed"])).toEqual([]);
    t.baseline(["a", "missed"]);
    expect(t.observe(["a", "missed", "live"])).toEqual(["live"]);
  });

  it("a card that was removed and comes back arrives again", () => {
    const t = new ArrivalTracker();
    t.baseline(["a", "b"]);
    t.observe(["a"]);
    expect(t.observe(["a", "b"])).toEqual(["b"]);
  });
});

describe("typing in", () => {
  it("starts empty, finishes within the window and never overshoots", () => {
    expect(typedLength(100, 0)).toBe(0);
    expect(typedLength(100, -5)).toBe(0);
    expect(typedLength(100, TYPE_MS / 2)).toBeGreaterThan(0);
    expect(typedLength(100, TYPE_MS / 2)).toBeLessThan(100);
    expect(typedLength(5000, TYPE_MS)).toBe(5000);
    expect(typedLength(100, 10_000)).toBe(100);
  });

  it("short titles type fast rather than stretching over the whole window", () => {
    expect(typedLength(12, 250)).toBe(12);
  });
});

describe("arrival phases", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("text shows a skeleton for the minimum, reveals, then ends", () => {
    const s = new ArrivalStore();
    s.start("n", true);
    expect(s.phase("n")).toBe("skeleton");
    vi.advanceTimersByTime(MIN_SKELETON_MS - 1);
    expect(s.phase("n")).toBe("skeleton");
    vi.advanceTimersByTime(1);
    expect(s.phase("n")).toBe("reveal");
    vi.advanceTimersByTime(REVEAL_MS);
    expect(s.phase("n")).toBeNull();
  });

  it("an image keeps its skeleton until it reports loaded", () => {
    const s = new ArrivalStore();
    s.start("i", false);
    vi.advanceTimersByTime(MIN_SKELETON_MS + 2000);
    expect(s.phase("i")).toBe("skeleton");
    s.markReady("i");
    expect(s.phase("i")).toBe("reveal");
  });

  it("a card ready before the minimum still waits out the minimum", () => {
    const s = new ArrivalStore();
    s.start("p", false);
    s.markReady("p");
    expect(s.phase("p")).toBe("skeleton");
    vi.advanceTimersByTime(MIN_SKELETON_MS);
    expect(s.phase("p")).toBe("reveal");
  });

  it("a frame that never reports in is revealed after the timeout", () => {
    const s = new ArrivalStore();
    s.start("p", false);
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(s.phase("p")).toBe("reveal");
  });

  it("notifies subscribers on each phase change", () => {
    const s = new ArrivalStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.start("n", true);
    vi.advanceTimersByTime(MIN_SKELETON_MS);
    vi.advanceTimersByTime(REVEAL_MS);
    expect(cb).toHaveBeenCalledTimes(3);
  });
});
