import { describe, expect, it } from "vitest";
import { PointerModel } from "../src/input/pointer-model";
import type { EventPoster, MouseButton } from "../src/input/poster";
import { TrackpadInputSink } from "../src/input/trackpad";

type Posted =
  | { readonly op: "move"; readonly dx: number; readonly dy: number }
  | { readonly op: "button"; readonly button: MouseButton; readonly down: boolean }
  | { readonly op: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly op: "key"; readonly code: number };

class RecordingPoster implements EventPoster {
  readonly posted: Posted[] = [];
  moveBy(dx: number, dy: number): void {
    this.posted.push({ op: "move", dx, dy });
  }
  button(button: MouseButton, down: boolean): void {
    this.posted.push({ op: "button", button, down });
  }
  scroll(dx: number, dy: number): void {
    this.posted.push({ op: "scroll", dx, dy });
  }
  tapKey(code: number): void {
    this.posted.push({ op: "key", code });
  }
}

describe("PointerModel", () => {
  it("carries sub-pixel remainders so many tiny moves sum to the full distance", () => {
    const model = new PointerModel();
    let total = 0;
    for (let i = 0; i < 10; i++) total += model.accelerate(0.3, 0, 8).dx;
    // 0.3 * gain(0.0375 pt/ms ≈ 1.25) * 10 ≈ 3.75 -> integers emitted sum to 3, remainder < 1.
    expect(total).toBe(3);
  });

  it("gains up with speed and clamps at the max", () => {
    const slow = new PointerModel().accelerate(1, 0, 100).dx; // ~0.01 pt/ms -> gain ~1.21
    const fast = new PointerModel().accelerate(40, 0, 8).dx; // 5 pt/ms -> gain clamped 3.5
    expect(slow).toBe(1);
    expect(fast).toBe(140);
  });
});

describe("TrackpadInputSink", () => {
  it("coalesces consecutive moves and flushes them before a click", () => {
    const poster = new RecordingPoster();
    const sink = new TrackpadInputSink(poster);
    sink.handle([
      { k: "move", dx: 10, dy: 0, t: 0 },
      { k: "move", dx: 10, dy: 0, t: 8 },
      { k: "click", button: "left", t: 20 },
      { k: "move", dx: 0, dy: 5, t: 30 },
    ]);
    expect(poster.posted.map((p) => p.op)).toEqual(["move", "button", "button", "move"]);
    expect(poster.posted[0]).toMatchObject({ op: "move", dy: 0 });
    expect((poster.posted[0] as { dx: number }).dx).toBeGreaterThanOrEqual(20);
    expect(poster.posted[1]).toEqual({ op: "button", button: "left", down: true });
    expect(poster.posted[2]).toEqual({ op: "button", button: "left", down: false });
  });

  it("holds the left button across a drag, ignores clicks while dragging, and ignores unbalanced phases", () => {
    const poster = new RecordingPoster();
    const sink = new TrackpadInputSink(poster);
    sink.handle([
      { k: "drag", phase: "end", t: 0 }, // no drag in progress: ignored
      { k: "drag", phase: "start", t: 1 },
      { k: "drag", phase: "start", t: 2 }, // already dragging: ignored
      { k: "click", button: "right", t: 3 }, // ignored while dragging
      { k: "move", dx: 4, dy: 4, t: 10 },
      { k: "drag", phase: "end", t: 20 },
    ]);
    expect(poster.posted).toEqual([
      { op: "button", button: "left", down: true },
      { op: "move", dx: expect.any(Number) as number, dy: expect.any(Number) as number },
      { op: "button", button: "left", down: false },
    ]);
  });

  it("skips zero scroll reports but keeps the fractional carry", () => {
    const poster = new RecordingPoster();
    const sink = new TrackpadInputSink(poster);
    sink.handle([
      { k: "scroll", dx: 0, dy: 0.6, phase: "began", t: 0 },
      { k: "scroll", dx: 0, dy: 0.6, phase: "changed", t: 8 },
    ]);
    expect(poster.posted).toEqual([{ op: "scroll", dx: 0, dy: 1 }]);
  });
});
