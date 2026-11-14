import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assignSlots, FOCUS_MIN_SHARE, requestSettle, resetLiveModels, SETTLE_MAX_WAIT_MS, SETTLE_MS, useLiveModelStore, viewportBand, visibility, type Candidate, type Slots } from "./liveModel";

const screen = { top: 0, bottom: 800, width: 400 };
const frame = (y: number) => ({ x: 20, y, width: 360, height: 270 });
const at = (id: string, y: number, extra: Partial<Candidate> = {}): Candidate => ({ id, rank: 1, poster: true, ...visibility(frame(y), screen), ...extra });
const none: Slots = { live: [], pinned: null };

describe("visibility", () => {
  it("measures the part of a frame inside the clear band", () => {
    expect(visibility(frame(100), screen)).toEqual({ area: 360 * 270, share: 1 });
    expect(visibility(frame(-135), screen).share).toBeCloseTo(0.5);
    expect(visibility(frame(800 - 27), screen).share).toBeCloseTo(0.1);
    expect(visibility(frame(900), screen)).toEqual({ area: 0, share: 0 });
    expect(visibility({ x: 400, y: 100, width: 360, height: 270 }, screen).share).toBe(0); // a pager page off to the side
    expect(visibility({ x: 0, y: 0, width: 0, height: 0 }, screen)).toEqual({ area: 0, share: 0 });
  });

  it("leaves out what the header and the composer cover", () => {
    const band = viewportBand({ width: 400, height: 852 }, { top: 59, bottom: 34 });
    // A frame tucked under the header counts only below it, one behind the composer only above it.
    expect(visibility(frame(band.top - 135), band).share).toBeCloseTo(0.5);
    expect(visibility(frame(band.bottom - 54), band).share).toBeCloseTo(0.2);
    expect(visibility(frame(band.top + 10), band).share).toBe(1);
  });
});

describe("assignSlots", () => {
  it("gives the focus slot to the most visible model", () => {
    const slots = assignSlots([at("top", -200), at("middle", 300), at("bottom", 700)], none, 1);
    expect(slots.live).toEqual(["middle"]);
  });

  it("follows the viewport as the list scrolls", () => {
    let slots = assignSlots([at("a", 300), at("b", 900)], none, 1);
    expect(slots.live).toEqual(["a"]);
    slots = assignSlots([at("a", -250), at("b", 350)], slots, 1);
    expect(slots.live).toEqual(["b"]);
  });

  it("keeps the holder until another model shows clearly more of itself", () => {
    // `a` holds with 60% on screen; `b` at 66% is not enough to move a 40 MB scene.
    const held: Slots = { live: ["a"], pinned: null };
    expect(assignSlots([at("a", -108), at("b", 800 - 178)], held, 1).live).toEqual(["a"]);
    expect(assignSlots([at("a", -200), at("b", 800 - 270)], held, 1).live).toEqual(["b"]);
  });

  it("breaks a tie toward the newest message", () => {
    expect(assignSlots([at("old", 100, { rank: 1 }), at("new", 450, { rank: 2 })], none, 1).live).toEqual(["new"]);
  });

  it("needs a real share of the frame on screen to move focus there", () => {
    const sliver = 800 - 270 * (FOCUS_MIN_SHARE - 0.05);
    expect(assignSlots([at("peek", sliver)], none, 1).live).toEqual([]);
    // Scrolled into text with only a sliver left: the holder keeps it instead of reloading something.
    expect(assignSlots([at("a", 2000), at("peek", sliver)], { live: ["a"], pinned: null }, 1).live).toEqual(["a"]);
  });

  it("frees the slots of views that unmounted, failed or sit on a covered screen", () => {
    expect(assignSlots([], { live: ["a", "b"], pinned: "a" }).live).toEqual([]);
    expect(assignSlots([at("b", 300)], { live: ["a"], pinned: null }, 1).live).toEqual(["b"]);
  });

  it("keeps a tapped model live while any of it is on screen, then follows the viewport again", () => {
    const tapped: Slots = { live: ["small"], pinned: "small" };
    let slots = assignSlots([at("small", 800 - 30), at("big", 200)], tapped, 1);
    expect(slots).toEqual({ live: ["small"], pinned: "small" });
    slots = assignSlots([at("small", 900), at("big", 200)], slots, 1);
    expect(slots).toEqual({ live: ["big"], pinned: null });
  });

  it("uses the second slot to make posters for models wholly in view that have none, most visible first", () => {
    const candidates = [
      at("focus", 0, { poster: false, rank: 3 }),
      at("a", 280, { poster: false, rank: 1 }),
      at("b", 520, { poster: false, rank: 2 }),
      at("peek", 780, { poster: false }),
      at("done", 300, { rank: 1 }),
    ];
    expect(assignSlots(candidates, none, 2).live).toEqual(["focus", "b"]);
    // `b` got its poster; the slot moves on to the next one still missing.
    const next = candidates.map((c) => (c.id === "b" ? { ...c, poster: true } : c));
    expect(assignSlots(next, { live: ["focus", "b"], pinned: null }, 2).live).toEqual(["focus", "a"]);
    // Only a model peeking past the composer lacks one: its snapshot would hold chrome, so back to one live view.
    const rest = next.map((c) => (c.id === "a" ? { ...c, poster: true } : c));
    expect(assignSlots(rest, { live: ["focus", "a"], pinned: null }, 2).live).toEqual(["focus"]);
  });

  it("lets the poster slot finish the model it started while that model stays in view", () => {
    const held: Slots = { live: ["focus", "slow"], pinned: null };
    const candidates = [at("focus", 0, { rank: 5 }), at("slow", 450, { poster: false, rank: 1 }), at("other", 300, { poster: false, rank: 2 })];
    expect(assignSlots(candidates, held, 2).live).toEqual(["focus", "slow"]);
    // Scrolled so `slow` is half out of view: the slot goes to one it can finish.
    const moved = candidates.map((c) => (c.id === "slow" ? at("slow", 700, { poster: false, rank: 1 }) : c));
    expect(assignSlots(moved, held, 2).live).toEqual(["focus", "other"]);
  });

  it("never makes a poster for a model entirely off screen", () => {
    expect(assignSlots([at("focus", 200), at("far", 2000, { poster: false })], none, 2).live).toEqual(["focus"]);
  });
});

describe("settling", () => {
  // With no view registered a settle frees the slot, so a stale holder shows when one ran.
  const settled = () => useLiveModelStore.getState().live.length === 0;
  beforeEach(() => {
    vi.useFakeTimers();
    resetLiveModels();
    useLiveModelStore.setState({ live: ["stale"], pinned: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles SETTLE_MS after the scroll rests", async () => {
    requestSettle();
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled()).toBe(true);
  });

  it("still settles every SETTLE_MAX_WAIT_MS through a long continuous scroll", async () => {
    // A scroll event every 16 ms never leaves a SETTLE_MS gap.
    let elapsed = 0;
    while (!settled() && elapsed < SETTLE_MAX_WAIT_MS * 2) {
      requestSettle();
      await vi.advanceTimersByTimeAsync(16);
      elapsed += 16;
    }
    expect(settled()).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(SETTLE_MAX_WAIT_MS);
    expect(elapsed).toBeLessThan(SETTLE_MAX_WAIT_MS + 16 * 2);
  });
});
