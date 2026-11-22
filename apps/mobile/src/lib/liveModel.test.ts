import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openModel, registerModel, requestSettle, resetLiveModels, settle, SETTLE_MAX_WAIT_MS, SETTLE_MS, unregisterModel, useLiveModelStore, viewportBand, visibility, type LiveModelEntry } from "./liveModel";

const screen = { top: 0, bottom: 800, width: 400 };
const frame = (y: number) => ({ x: 20, y, width: 360, height: 270 });
/** A mounted view whose frame sits at `y`; change `at.y` to scroll it. */
const view = (y: number, extra: Partial<LiveModelEntry> = {}) => {
  const at = { y };
  const entry: LiveModelEntry = { failed: false, focused: true, measure: () => Promise.resolve(visibility(frame(at.y), screen)), ...extra };
  return { at, entry };
};
const open = () => useLiveModelStore.getState().open;

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

describe("the open model", () => {
  beforeEach(() => {
    resetLiveModels();
  });

  it("is none until a tap, however visible the models are", async () => {
    registerModel("a", view(100).entry);
    registerModel("b", view(400).entry);
    await settle();
    expect(open()).toBeNull();
  });

  it("is one at a time: tapping another closes the first", async () => {
    registerModel("a", view(100).entry);
    registerModel("b", view(400).entry);
    openModel("a");
    openModel("b");
    expect(open()).toBe("b");
    await settle();
    expect(open()).toBe("b");
  });

  it("stays open while any of it is on screen, and closes once scrolled away", async () => {
    const a = view(100);
    registerModel("a", a.entry);
    openModel("a");
    a.at.y = 800 - 20;
    await settle();
    expect(open()).toBe("a");
    a.at.y = 900;
    await settle();
    expect(open()).toBeNull();
  });

  it("closes when its screen is covered, it failed or it unmounted", async () => {
    registerModel("a", view(100, { focused: false }).entry);
    openModel("a");
    await settle();
    expect(open()).toBeNull();
    registerModel("b", view(100, { failed: true }).entry);
    openModel("b");
    await settle();
    expect(open()).toBeNull();
    registerModel("c", view(100).entry);
    openModel("c");
    unregisterModel("c");
    expect(open()).toBeNull();
  });
});

describe("settling", () => {
  // With no view registered a settle closes the open model, so a stale one shows when one ran.
  const settled = () => open() === null;
  beforeEach(() => {
    vi.useFakeTimers();
    resetLiveModels();
    useLiveModelStore.setState({ open: "stale" });
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
