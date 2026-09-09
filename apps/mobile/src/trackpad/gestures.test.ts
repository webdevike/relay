import { describe, expect, it } from "vitest";
import type { InputEvent } from "@relay/protocol";
import type { PointerSpeed } from "@/state/settings";
import { TrackpadGestureModel, type Haptic, type RawTouch } from "./gestures";

interface PendingTimer {
  run: () => void;
  ms: number;
}

/**
 * Deterministic harness: `now()` (used only for schedule-driven events — momentum ticks, the
 * drag-hold timeout) tracks the last fed sample's `t`, then advances by exactly `ms` when a
 * pending timer is manually ticked, so scheduled event timestamps stay in lockstep with the
 * touch timeline instead of a disconnected wall clock.
 */
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
    reset(): void {
      model.reset();
    },
  };
}

function isScroll(event: InputEvent): event is Extract<InputEvent, { k: "scroll" }> {
  return event.k === "scroll";
}

describe("tap", () => {
  it("emits exactly one left click for a quick, low-travel tap", () => {
    const h = makeHarness();
    h.feed(1, "began", 100, 100, 0);
    h.feed(1, "ended", 102, 101, 60);
    expect(h.events).toEqual([{ k: "click", button: "left", t: 60 }]);
    expect(h.haptics).toEqual(["select"]);
  });

  it("does not click when the hold is too slow, even with no travel", () => {
    const h = makeHarness();
    h.feed(1, "began", 100, 100, 0);
    h.feed(1, "ended", 100, 100, 250);
    expect(h.events).toEqual([]);
    expect(h.haptics).toEqual([]);
  });

  it("commits to a move instead of a click once travel crosses the tap threshold", () => {
    const h = makeHarness();
    h.feed(1, "began", 100, 100, 0);
    h.feed(1, "moved", 130, 100, 30);
    h.feed(1, "ended", 130, 100, 60);
    expect(h.events).toEqual([{ k: "move", dx: 30, dy: 0, t: 30 }]);
  });
});

describe("one-finger move", () => {
  it("scales dx/dy by pointerSpeed once past the tap threshold, with no click", () => {
    const h = makeHarness({ pointerSpeed: "slow" }); // 0.7x
    h.feed(1, "began", 0, 0, 0);
    h.feed(1, "moved", 20, 0, 20); // travel 20 >= 8 -> commit, catch-up jump from start
    h.feed(1, "moved", 30, 0, 40); // incremental +10
    h.feed(1, "ended", 30, 0, 60);
    expect(h.events).toEqual([
      { k: "move", dx: 14, dy: 0, t: 20 },
      { k: "move", dx: 7, dy: 0, t: 40 },
    ]);
    expect(h.haptics).toEqual([]);
  });

  it("applies the fast multiplier", () => {
    const h = makeHarness({ pointerSpeed: "fast" }); // 1.4x
    h.feed(1, "began", 0, 0, 0);
    h.feed(1, "moved", 10, 0, 10);
    expect(h.events).toEqual([{ k: "move", dx: 14, dy: 0, t: 10 }]);
  });
});

describe("two-finger tap", () => {
  it("emits a right click when both fingers land and lift together within the windows", () => {
    const h = makeHarness();
    h.feed(1, "began", 100, 100, 0);
    h.feed(2, "began", 120, 100, 20); // 20ms skew, within 60ms
    h.feed(1, "ended", 101, 101, 100);
    h.feed(2, "ended", 121, 99, 120); // total duration 120ms < 200ms
    expect(h.events).toEqual([{ k: "click", button: "right", t: 120 }]);
    expect(h.haptics).toEqual(["impactMedium"]);
  });

  it("does not click when the second finger lands outside the down-skew window", () => {
    const h = makeHarness();
    h.feed(1, "began", 100, 100, 0);
    h.feed(2, "began", 120, 100, 100); // 100ms skew > 60ms
    h.feed(1, "ended", 100, 100, 130);
    h.feed(2, "ended", 120, 100, 140);
    expect(h.events.some((e) => e.k === "click")).toBe(false);
  });
});

describe("double-tap-and-hold drag", () => {
  it("starts a drag on movement past the arm threshold, tracks moves, ends on lift", () => {
    const h = makeHarness();
    h.feed(1, "began", 50, 50, 0);
    h.feed(1, "ended", 51, 50, 50); // tap -> click left, arms the re-touch window
    h.feed(2, "began", 52, 50, 150); // within 250ms -> armed
    h.feed(2, "moved", 62, 50, 180); // travel 10 > 4 -> drag start + catch-up move
    h.feed(2, "moved", 72, 50, 200); // +10 incremental
    h.feed(2, "ended", 72, 50, 230);

    expect(h.events).toEqual([
      { k: "click", button: "left", t: 50 },
      { k: "drag", phase: "start", t: 180 },
      { k: "move", dx: 10, dy: 0, t: 180 },
      { k: "move", dx: 10, dy: 0, t: 200 },
      { k: "drag", phase: "end", t: 230 },
    ]);
    expect(h.haptics).toEqual(["select", "impactMedium", "tap"]);
  });

  it("starts a drag purely from holding past 120ms, with no movement", () => {
    const h = makeHarness();
    h.feed(1, "began", 50, 50, 0);
    h.feed(1, "ended", 50, 50, 40);
    h.feed(2, "began", 50, 50, 100); // armed, schedules a 120ms hold timeout
    expect(h.pendingCount()).toBe(1);

    h.tick(); // now: 100 -> 220
    expect(h.events).toEqual([
      { k: "click", button: "left", t: 40 },
      { k: "drag", phase: "start", t: 220 },
    ]);

    h.feed(2, "ended", 50, 50, 225);
    expect(h.events).toEqual([
      { k: "click", button: "left", t: 40 },
      { k: "drag", phase: "start", t: 220 },
      { k: "drag", phase: "end", t: 225 },
    ]);
    expect(h.haptics).toEqual(["select", "impactMedium", "tap"]);
  });

  it("resolves as an ordinary second tap when it lifts before arming", () => {
    const h = makeHarness();
    h.feed(1, "began", 50, 50, 0);
    h.feed(1, "ended", 50, 50, 40); // tap 1
    h.feed(2, "began", 50, 50, 100);
    h.feed(2, "ended", 51, 50, 150); // quick, low travel, well before the 120ms timer fires
    expect(h.events).toEqual([
      { k: "click", button: "left", t: 40 },
      { k: "click", button: "left", t: 150 },
    ]);
    expect(h.haptics).toEqual(["select", "select"]);
  });

  it("does not arm when the re-touch lands outside the 250ms window", () => {
    const h = makeHarness();
    h.feed(1, "began", 50, 50, 0);
    h.feed(1, "ended", 50, 50, 40); // tap 1
    h.feed(2, "began", 50, 50, 400); // 360ms later, outside the window
    h.feed(2, "moved", 60, 50, 420); // travel 10pt: would arm-commit if (wrongly) armed
    expect(h.events).toEqual([
      { k: "click", button: "left", t: 40 },
      { k: "move", dx: 10, dy: 0, t: 420 },
    ]);
  });
});

describe("momentum", () => {
  it("decays at 0.95/tick and terminates with momentumEnded once |v| drops below 2pt/s", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 100); // commit scroll
    h.feed(1, "moved", 0, -40, 116); // dt 16ms, avg dy -10
    h.feed(1, "moved", 0, -60, 132); // dt 16ms, avg dy -10 -> 32ms of window, vy = -625pt/s
    h.feed(1, "ended", 0, -60, 148); // fast lift -> ended, then momentum takes over

    expect(h.events.filter(isScroll).map((e) => e.phase)).toEqual(["began", "changed", "changed", "ended"]);
    expect(h.pendingCount()).toBe(1); // first momentum tick scheduled

    h.tick(); // v = -625 * 0.95 = -593.75; dy = v * 0.016
    expect(h.events.at(-1)).toEqual({ k: "scroll", dx: 0, dy: -9.5, phase: "momentum", t: 164 });

    let guard = 0;
    while (h.pendingCount() > 0 && guard < 500) {
      h.tick();
      guard += 1;
    }
    expect(guard).toBeLessThan(500);
    expect(h.pendingCount()).toBe(0);

    const scrollEvents = h.events.filter(isScroll);
    expect(scrollEvents.at(-1)).toMatchObject({ k: "scroll", dx: 0, dy: 0, phase: "momentumEnded" });

    const momentumTicks = scrollEvents.filter((e) => e.phase === "momentum");
    expect(momentumTicks.length).toBeGreaterThan(2);
    expect(momentumTicks.every((e) => e.dx === 0)).toBe(true);
    // Strictly decaying magnitude, tick over tick.
    momentumTicks.reduce((prevMagnitude, tick) => {
      const magnitude = Math.abs(tick.dy);
      expect(magnitude).toBeLessThan(prevMagnitude);
      return magnitude;
    }, Infinity);
  });

  it("does not trigger momentum when lift velocity is below the threshold", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 500); // single slow move, seeds vx/vy at 0
    h.feed(1, "ended", 0, -20, 520);
    expect(h.pendingCount()).toBe(0);
    expect(h.events.filter(isScroll).map((e) => e.phase)).toEqual(["began", "ended"]);
  });
});

describe("two-finger scroll", () => {
  it("emits began/changed/ended with natural scrolling on (pass-through)", () => {
    const h = makeHarness({ naturalScrolling: true });
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 40, 0);
    h.feed(1, "moved", -20, -20, 100); // travel ~28.3 >= 10 -> began, avg dx=dy=-10
    h.feed(1, "moved", -30, -30, 400); // dt 300ms, avg dx=dy=-5 -> vx=vy=-16.7pt/s (< 40)
    h.feed(1, "ended", -30, -30, 450);

    const scrollEvents = h.events.filter(isScroll);
    expect(scrollEvents.map((e) => e.phase)).toEqual(["began", "changed", "ended"]);
    expect(scrollEvents[0]).toEqual({ k: "scroll", dx: -10, dy: -10, phase: "began", t: 100 });
    expect(scrollEvents[1]).toEqual({ k: "scroll", dx: -5, dy: -5, phase: "changed", t: 400 });
    expect(scrollEvents[2]).toEqual({ k: "scroll", dx: 0, dy: 0, phase: "ended", t: 450 });
    expect(h.pendingCount()).toBe(0); // no momentum
  });

  it("inverts both axes with natural scrolling off", () => {
    const h = makeHarness({ naturalScrolling: false });
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 40, 0);
    h.feed(1, "moved", -20, -20, 100);
    h.feed(1, "ended", -20, -20, 150);

    const scrollEvents = h.events.filter(isScroll);
    expect(scrollEvents[0]).toEqual({ k: "scroll", dx: 10, dy: 10, phase: "began", t: 100 });
  });
});

describe("cancellation", () => {
  it("ends a drag cleanly when the touch is cancelled mid-drag", () => {
    const h = makeHarness();
    h.feed(1, "began", 50, 50, 0);
    h.feed(1, "ended", 50, 50, 40); // tap -> click left, arm
    h.feed(2, "began", 50, 50, 100); // armed
    h.feed(2, "moved", 60, 50, 120); // travel 10 > 4 -> drag start
    h.feed(2, "cancelled", 65, 50, 140);

    expect(h.events).toEqual([
      { k: "click", button: "left", t: 40 },
      { k: "drag", phase: "start", t: 120 },
      { k: "move", dx: 10, dy: 0, t: 120 },
      { k: "drag", phase: "end", t: 140 },
    ]);
    expect(h.haptics).toEqual(["select", "impactMedium", "tap"]);
  });

  it("cleanly ends a scroll when cancelled, without momentum", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 100); // commit scroll
    h.feed(1, "cancelled", 0, -20, 120);

    expect(h.events.filter(isScroll).map((e) => e.phase)).toEqual(["began", "ended"]);
    expect(h.pendingCount()).toBe(0);
  });

  it("does not let a leftover finger from a cancelled scroll fire a spurious click", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 100); // commit scroll
    h.feed(1, "cancelled", 0, -20, 120); // finger 2 is still down
    h.feed(2, "ended", 40, 0, 125); // quick + low travel — would look like a tap if rebased

    expect(h.events.some((e) => e.k === "click")).toBe(false);
  });

  it("does not let a leftover finger from a cancelled tap-pending pair fire a spurious click", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 5, 0, 10); // still tap-eligible so far
    h.feed(1, "cancelled", 0, 0, 20); // finger 2 is still down, pair never resolved
    h.feed(2, "ended", 5, 0, 25); // would look like a valid left tap if rebased

    expect(h.events.some((e) => e.k === "click")).toBe(false);
  });
});

describe("palm / extra fingers", () => {
  it("ignores a third finger during an active two-finger scroll", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 100); // commit scroll
    h.feed(3, "began", 80, 80, 110); // palm / third finger
    h.feed(3, "moved", 90, 90, 120); // must not affect scroll math
    h.feed(1, "moved", 0, -30, 400);
    h.feed(3, "ended", 90, 90, 410);
    h.feed(1, "ended", 0, -30, 450);

    const scrollEvents = h.events.filter(isScroll);
    expect(scrollEvents.map((e) => e.phase)).toEqual(["began", "changed", "ended"]);
    expect(scrollEvents[1]).toEqual({ k: "scroll", dx: 0, dy: -5, phase: "changed", t: 400 });
  });

  it("ignores a third finger landing during a one-finger move", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(1, "moved", 20, 0, 20); // commit move
    h.feed(2, "began", 50, 50, 30); // bystander while already committed
    h.feed(1, "moved", 30, 0, 40);
    h.feed(2, "ended", 50, 50, 50); // silently dropped, no click/effect

    expect(h.events).toEqual([
      { k: "move", dx: 20, dy: 0, t: 20 },
      { k: "move", dx: 10, dy: 0, t: 40 },
    ]);
  });
});

describe("reset (unmount)", () => {
  it("emits drag end when resetting mid-drag", () => {
    const h = makeHarness();
    h.feed(1, "began", 50, 50, 0);
    h.feed(1, "ended", 50, 50, 40); // tap -> click left, arm
    h.feed(2, "began", 50, 50, 100); // armed
    h.feed(2, "moved", 60, 50, 120); // travel 10 > 4 -> drag start

    h.reset();

    expect(h.events.at(-1)).toEqual({ k: "drag", phase: "end", t: 120 });
  });

  it("emits scroll ended when resetting mid-scroll", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 100); // commit scroll

    h.reset();

    expect(h.events.at(-1)).toEqual({ k: "scroll", dx: 0, dy: 0, phase: "ended", t: 100 });
  });

  it("emits momentumEnded and stops ticking when resetting mid-momentum", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 100); // commit scroll
    h.feed(1, "moved", 0, -40, 116); // dt 16ms, avg dy -10
    h.feed(1, "moved", 0, -60, 132); // dt 16ms, avg dy -10 -> 32ms of window, vy = -625pt/s
    h.feed(1, "ended", 0, -60, 148); // lift -> momentum begins
    expect(h.pendingCount()).toBe(1); // one tick already scheduled

    h.reset();

    expect(h.events.at(-1)).toEqual({ k: "scroll", dx: 0, dy: 0, phase: "momentumEnded", t: 148 });

    // The already-scheduled tick still exists as a raw timer, but must be inert now: no further
    // momentum (or any other) event may reach the Mac after reset.
    const eventCountAfterReset = h.events.length;
    h.tick();
    expect(h.events.length).toBe(eventCountAfterReset);
  });

  it("emits nothing extra when resetting from an uncommitted or idle phase", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0); // tap-pending, nothing committed yet

    h.reset();

    expect(h.events).toEqual([]);
    expect(h.haptics).toEqual([]);
  });
});

describe("malformed input", () => {
  it("drops a non-finite touch sample entirely (never reaches an emitted event, and does not corrupt subsequent tracking)", () => {
    const h = makeHarness();
    h.feed(1, "began", NaN, NaN, 0);
    h.feed(1, "moved", NaN, NaN, 20);
    expect(h.events).toEqual([]);

    // The dropped samples must not have been silently tracked either — a fresh, valid begin for
    // the same finger id starts a clean gesture, as if the NaN samples never happened.
    h.feed(1, "began", 10, 10, 100);
    h.feed(1, "ended", 11, 10, 150);
    expect(h.events).toEqual([{ k: "click", button: "left", t: 150 }]);
  });

  it("a backwards (non-monotonic) sample timestamp cannot fabricate momentum from a negligible movement", () => {
    const h = makeHarness();
    h.feed(1, "began", 0, 0, 0);
    h.feed(2, "began", 40, 0, 0);
    h.feed(1, "moved", 0, -20, 100); // commit scroll
    h.feed(1, "moved", 0, -25, 90); // t goes backwards: 90 < 100, only a 5pt movement
    h.feed(1, "ended", 0, -25, 95);

    expect(h.pendingCount()).toBe(0); // no momentum tick was scheduled
    expect(h.events.filter(isScroll).map((e) => e.phase)).toEqual(["began", "changed", "ended"]);
  });
});
