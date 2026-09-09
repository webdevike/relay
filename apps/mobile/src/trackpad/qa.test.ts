import { describe, expect, it } from "vitest";
import type { InputEvent } from "@relay/protocol";
import type { PointerSpeed } from "@/state/settings";
import { TrackpadGestureModel, type Haptic, type RawTouch } from "./gestures";

interface PendingTimer {
  run: () => void;
  ms: number;
}

/** Mirrors gestures.test.ts's harness exactly (same deterministic now()/schedule() seam). */
function makeHarness(opts: { pointerSpeed?: PointerSpeed; naturalScrolling?: boolean } = {}) {
  const events: InputEvent[] = [];
  const haptics: Haptic[] = [];
  const pending: PendingTimer[] = [];
  let now = 0;
  const settings = {
    pointerSpeed: opts.pointerSpeed ?? "normal",
    naturalScrolling: opts.naturalScrolling ?? true,
  };

  const model = new TrackpadGestureModel({
    getSettings: () => settings,
    schedule: (run, ms) => {
      pending.push({ run, ms });
    },
    now: () => now,
    emit: (es, hs) => {
      events.push(...es);
      haptics.push(...hs);
    },
  });

  return {
    events,
    haptics,
    pendingCount: () => pending.length,
    feed(id: number, phase: RawTouch["phase"], x: number, y: number, t: number): void {
      now = t;
      model.touch({ id, phase, x, y, t });
    },
    tick(): void {
      const next = pending.shift();
      if (next === undefined) throw new Error("no pending timer to advance");
      now += next.ms;
      next.run();
    },
  };
}

function isScroll(event: InputEvent): event is Extract<InputEvent, { k: "scroll" }> {
  return event.k === "scroll";
}

describe("immediate double tap", () => {
  it("a second tap that lands the instant the first one lifts is still two left clicks, not a drag", () => {
    const h = makeHarness();
    h.feed(1, "began", 50, 50, 0);
    h.feed(1, "ended", 50, 50, 40); // tap 1 -> click, arms the re-touch window
    h.feed(1, "began", 50, 50, 40); // 0ms gap, same finger id reused
    h.feed(1, "ended", 51, 50, 70); // quick, low travel -- well inside the tap window
    expect(h.events).toEqual([
      { k: "click", button: "left", t: 40 },
      { k: "click", button: "left", t: 70 },
    ]);
    expect(h.haptics).toEqual(["select", "select"]);
  });
});

describe("momentum interrupted by a new touch", () => {
  it("emits momentumEnded immediately on the new touch, before any new scroll can begin", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 100); // scroll began
    h.feed(1, "moved", 0, -40, 116); // vy = -625pt/s
    h.feed(1, "ended", 0, -40, 132); // scroll ended -> momentum starts, one tick pending
    expect(h.pendingCount()).toBe(1);

    h.feed(3, "began", 10, 10, 140); // a fresh touch lands mid-glide
    expect(h.events.filter(isScroll).map((e) => e.phase)).toEqual(["began", "changed", "ended", "momentumEnded"]);

    h.feed(3, "moved", 40, 10, 160); // the new finger becomes an ordinary move
    expect(h.events.at(-1)).toMatchObject({ k: "move" });

    // The stale, already-scheduled momentum tick must be inert now that the phase moved on.
    expect(h.pendingCount()).toBe(1);
    h.tick();
    expect(h.events.filter(isScroll).map((e) => e.phase)).toEqual(["began", "changed", "ended", "momentumEnded"]);
  });
});

describe("finger id reuse", () => {
  it("a finger id reused long after its prior gesture fully resolved starts a clean, unrelated gesture", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(1, "ended", 0, 0, 40); // tap -> click; phase parks in awaitingSecondTap

    // Well outside the 250ms re-arm window: ids 1 and 2 are reused for an unrelated two-finger scroll.
    h.feed(1, "began", 0, 0, 1000);
    h.feed(2, "began", 40, 0, 1000);
    h.feed(1, "moved", 0, -20, 1100);
    h.feed(1, "ended", 0, -20, 1150);

    expect(h.events.filter(isScroll).map((e) => e.phase)).toEqual(["began", "ended"]);
    expect(h.events.filter((e) => e.k === "click")).toHaveLength(1);
  });
});

describe("second finger mid one-finger move", () => {
  it("a bystander never clicks on lift, and the model is clean for the very next gesture", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(1, "moved", 20, 0, 20); // commit move
    h.feed(2, "began", 50, 50, 30); // bystander mid-move
    h.feed(2, "ended", 50, 50, 35); // quick + zero travel -- a textbook tap shape if it weren't ignored
    h.feed(1, "ended", 20, 0, 60); // the real, already-moving finger lifts too -- never tap-eligible

    expect(h.events.filter((e) => e.k === "click")).toHaveLength(0);

    // No leaked ignored-set/phase state: an unrelated tap right after works normally.
    h.feed(3, "began", 5, 5, 200);
    h.feed(3, "ended", 5, 5, 220);
    expect(h.events.filter((e) => e.k === "click")).toEqual([{ k: "click", button: "left", t: 220 }]);
  });
});

describe("cancelled with no active gesture", () => {
  it("cancelling an id that never began is a no-op", () => {
    const h = makeHarness();
    h.feed(1, "cancelled", 0, 0, 0);
    expect(h.events).toEqual([]);
    expect(h.haptics).toEqual([]);
    expect(h.pendingCount()).toBe(0);
  });

  it("a stray cancel arriving after its gesture already resolved is a no-op", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(1, "ended", 0, 0, 40); // resolves as a tap -> click
    const before = [...h.events];
    h.feed(1, "cancelled", 0, 0, 50); // duplicate/stale terminal event for the same id
    expect(h.events).toEqual(before);
  });
});

describe("unclamped huge deltas", () => {
  it("passes a huge single-sample delta through unclamped", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(1, "moved", 10000, 0, 20);
    expect(h.events).toEqual([{ k: "move", dx: 10000, dy: 0, t: 20 }]);
  });
});

