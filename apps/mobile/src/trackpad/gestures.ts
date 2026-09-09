import type { InputEvent } from "@relay/protocol";
import type { PointerSpeed } from "@/state/settings";

/**
 * Turns a raw multi-touch stream into trackpad semantics: pointer move, click, drag,
 * two-finger scroll with momentum, and tap-to-click — mirroring macOS trackpad conventions.
 * Pure state machine, no RN/timer imports: the caller feeds `touch()` samples and supplies
 * `schedule`/`now` so momentum and hold-to-drag timing are deterministic under test.
 */

/** Per-finger sample from the native touch stream. View-local coordinates, in points. */
export type TouchPhase = "began" | "moved" | "ended" | "cancelled";

export interface RawTouch {
  id: number;
  phase: TouchPhase;
  x: number;
  y: number;
  /** Client monotonic ms — same clock as `getClientTime()`. */
  t: number;
}

/** Feedback cues the model asks for; the caller maps these to `@/lib/haptics` calls. */
export type Haptic = "select" | "impactMedium" | "tap";

/** Fire-and-forget delayed callback, injected so momentum/hold timing is deterministic in tests. */
export type Scheduler = (run: () => void, ms: number) => void;

export interface TrackpadGestureConfig {
  getSettings: () => { pointerSpeed: PointerSpeed; naturalScrolling: boolean };
  schedule: Scheduler;
  /** Monotonic ms; used only for events not driven by a raw sample (momentum ticks, drag-hold). */
  now: () => number;
  emit: (events: InputEvent[], haptics: Haptic[]) => void;
}

const POINTER_SPEED_SCALE: Record<PointerSpeed, number> = { slow: 0.7, normal: 1, fast: 1.4 };

const TAP_WINDOW_MS = 200;
const TAP_MAX_TRAVEL = 8;
const TWO_TAP_DOWN_SKEW_MS = 60;
const TWO_TAP_MAX_TRAVEL = 10;
const DRAG_REARM_WINDOW_MS = 250;
const DRAG_ARM_TRAVEL = 4;
const DRAG_ARM_HOLD_MS = 120;
const MOMENTUM_TRIGGER_VELOCITY = 40;
const MOMENTUM_STOP_VELOCITY = 2;
const MOMENTUM_DECAY = 0.95;
const MOMENTUM_TICK_MS = 16;

interface FingerTrack {
  id: number;
  startX: number;
  startY: number;
  startT: number;
  lastX: number;
  lastY: number;
  lastT: number;
}

function track(s: RawTouch): FingerTrack {
  return { id: s.id, startX: s.x, startY: s.y, startT: s.t, lastX: s.x, lastY: s.y, lastT: s.t };
}

function travel(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Natural scrolling makes content follow the finger (touchscreen-like): the raw two-finger
 * delta passes through unchanged. Disabling it flips both axes to the classic wheel convention.
 * Shared by the live "changed" path and the synthetic momentum tail so both stay in lockstep.
 */
function applyNatural(dx: number, dy: number, natural: boolean): { dx: number; dy: number } {
  return natural ? { dx, dy } : { dx: -dx, dy: -dy };
}

type Phase =
  | { kind: "idle" }
  | { kind: "oneDown"; f: FingerTrack; dragArmed: boolean }
  | { kind: "oneMoving"; f: FingerTrack }
  | { kind: "dragging"; f: FingerTrack }
  /** 0 fingers down; a re-touch within `DRAG_REARM_WINDOW_MS` of `sinceT` arms drag detection. */
  | { kind: "awaitingSecondTap"; sinceT: number }
  | {
      kind: "twoDown";
      a: FingerTrack;
      b: FingerTrack;
      aEndedAt: number | null;
      bEndedAt: number | null;
      downSkewOk: boolean;
    }
  | { kind: "scrolling"; a: FingerTrack; b: FingerTrack; vx: number; vy: number }
  | { kind: "momentum"; vx: number; vy: number };

export class TrackpadGestureModel {
  private phase: Phase = { kind: "idle" };
  private readonly ignored = new Set<number>();

  constructor(private readonly config: TrackpadGestureConfig) {}

  /** Drops any in-flight gesture without emitting anything further; call on unmount. */
  reset(): void {
    this.phase = { kind: "idle" };
    this.ignored.clear();
  }

  touch(sample: RawTouch): void {
    if (this.ignored.has(sample.id)) {
      if (sample.phase === "ended" || sample.phase === "cancelled") this.ignored.delete(sample.id);
      return;
    }
    switch (sample.phase) {
      case "began":
        this.onBegan(sample);
        return;
      case "moved":
        this.onMoved(sample);
        return;
      case "ended":
        this.onEnded(sample);
        return;
      case "cancelled":
        this.onCancelled(sample);
        return;
    }
  }

  private emit(event: InputEvent, haptic?: Haptic): void {
    this.config.emit([event], haptic === undefined ? [] : [haptic]);
  }

  private onBegan(s: RawTouch): void {
    const p = this.phase;
    switch (p.kind) {
      case "idle":
        this.phase = { kind: "oneDown", f: track(s), dragArmed: false };
        return;
      case "awaitingSecondTap": {
        const armed = s.t - p.sinceT <= DRAG_REARM_WINDOW_MS;
        const f = track(s);
        this.phase = { kind: "oneDown", f, dragArmed: armed };
        if (armed) this.scheduleDragHoldTimeout(f.id);
        return;
      }
      case "oneDown":
        this.phase = {
          kind: "twoDown",
          a: p.f,
          b: track(s),
          aEndedAt: null,
          bEndedAt: null,
          downSkewOk: Math.abs(p.f.startT - s.t) <= TWO_TAP_DOWN_SKEW_MS,
        };
        return;
      case "momentum":
        // Touching down cancels the synthetic scroll and starts a fresh gesture.
        this.emit({ k: "scroll", dx: 0, dy: 0, phase: "momentumEnded", t: this.config.now() });
        this.phase = { kind: "oneDown", f: track(s), dragArmed: false };
        return;
      case "oneMoving":
      case "dragging":
      case "twoDown":
      case "scrolling":
        // A gesture is already committed on the recognized finger(s); this contact is a
        // bystander (palm, stray third finger) and never influences the outcome.
        this.ignored.add(s.id);
        return;
    }
  }

  private scheduleDragHoldTimeout(fingerId: number): void {
    this.config.schedule(() => {
      const p = this.phase;
      if (p.kind !== "oneDown" || p.f.id !== fingerId || !p.dragArmed) return;
      this.emit({ k: "drag", phase: "start", t: this.config.now() }, "impactMedium");
      this.phase = { kind: "dragging", f: p.f };
    }, DRAG_ARM_HOLD_MS);
  }

  private getScale(): number {
    return POINTER_SPEED_SCALE[this.config.getSettings().pointerSpeed];
  }

  private onMoved(s: RawTouch): void {
    const p = this.phase;
    switch (p.kind) {
      case "oneDown": {
        const dist = travel(p.f.startX, p.f.startY, s.x, s.y);
        // Tap requires travel < 8pt (so move begins at 8pt, inclusive); drag-arm requires
        // travel > 4pt (exclusive) per spec, so the two thresholds intentionally differ in
        // which side is inclusive.
        if (p.dragArmed) {
          if (dist <= DRAG_ARM_TRAVEL) return;
          this.commitDragViaMovement(p.f, s);
        } else {
          if (dist < TAP_MAX_TRAVEL) return;
          this.commitMove(p.f, s);
        }
        return;
      }
      case "oneMoving":
        this.emitMove(p.f, s);
        return;
      case "dragging":
        this.emitMove(p.f, s);
        return;
      case "twoDown":
        this.onTwoDownMoved(p, s);
        return;
      case "scrolling":
        this.onScrollingMoved(p, s);
        return;
      case "idle":
      case "awaitingSecondTap":
      case "momentum":
        // Move from an id we never recognized as begun; nothing to do.
        return;
    }
  }

  /** Cursor move, whether tracking a plain move or an active drag — same InputEvent either way. */
  private emitMove(f: FingerTrack, s: RawTouch): void {
    const scale = this.getScale();
    const dx = (s.x - f.lastX) * scale;
    const dy = (s.y - f.lastY) * scale;
    f.lastX = s.x;
    f.lastY = s.y;
    f.lastT = s.t;
    this.emit({ k: "move", dx, dy, t: s.t });
  }

  /** Tap-pending finger just crossed the move threshold: catch up in one jump, then track live. */
  private commitMove(f: FingerTrack, s: RawTouch): void {
    const scale = this.getScale();
    this.emit({ k: "move", dx: (s.x - f.startX) * scale, dy: (s.y - f.startY) * scale, t: s.t });
    this.phase = { kind: "oneMoving", f: { ...f, lastX: s.x, lastY: s.y, lastT: s.t } };
  }

  /** Drag-armed finger crossed the arm threshold: drag start plus the same catch-up jump. */
  private commitDragViaMovement(f: FingerTrack, s: RawTouch): void {
    const scale = this.getScale();
    const dx = (s.x - f.startX) * scale;
    const dy = (s.y - f.startY) * scale;
    this.config.emit(
      [
        { k: "drag", phase: "start", t: s.t },
        { k: "move", dx, dy, t: s.t },
      ],
      ["impactMedium"],
    );
    this.phase = { kind: "dragging", f: { ...f, lastX: s.x, lastY: s.y, lastT: s.t } };
  }

  private onTwoDownMoved(p: Extract<Phase, { kind: "twoDown" }>, s: RawTouch): void {
    const mine = p.a.id === s.id ? p.a : p.b;
    const other = p.a.id === s.id ? p.b : p.a;
    mine.lastX = s.x;
    mine.lastY = s.y;
    mine.lastT = s.t;
    // Once either finger has already lifted, this pair can no longer become a scroll — just
    // keep tracking the still-down finger so its own travel is judged accurately at its lift.
    if (p.aEndedAt !== null || p.bEndedAt !== null) return;
    const distMine = travel(mine.startX, mine.startY, mine.lastX, mine.lastY);
    const distOther = travel(other.startX, other.startY, other.lastX, other.lastY);
    // Tap requires travel < 10pt for both fingers, so scroll begins at 10pt (inclusive).
    if (Math.max(distMine, distOther) < TWO_TAP_MAX_TRAVEL) return;
    this.commitScroll(p.a, p.b, s.t);
  }

  /** Two-finger pair just crossed the tap-travel threshold: catch-up scroll, then track live. */
  private commitScroll(a: FingerTrack, b: FingerTrack, t: number): void {
    const avgDx = (a.lastX - a.startX + (b.lastX - b.startX)) / 2;
    const avgDy = (a.lastY - a.startY + (b.lastY - b.startY)) / 2;
    const { dx, dy } = applyNatural(avgDx, avgDy, this.config.getSettings().naturalScrolling);
    this.emit({ k: "scroll", dx, dy, phase: "began", t });
    this.phase = { kind: "scrolling", a, b, vx: 0, vy: 0 };
  }

  private onScrollingMoved(p: Extract<Phase, { kind: "scrolling" }>, s: RawTouch): void {
    const mine = p.a.id === s.id ? p.a : p.b;
    const dxRaw = s.x - mine.lastX;
    const dyRaw = s.y - mine.lastY;
    const dt = Math.max(1, s.t - mine.lastT);
    mine.lastX = s.x;
    mine.lastY = s.y;
    mine.lastT = s.t;
    // The other finger didn't move this sample, so its contribution to the average is 0 —
    // over a run of alternating single-finger samples this still converges to the true average.
    const avgDx = dxRaw / 2;
    const avgDy = dyRaw / 2;
    const { dx, dy } = applyNatural(avgDx, avgDy, this.config.getSettings().naturalScrolling);
    this.emit({ k: "scroll", dx, dy, phase: "changed", t: s.t });
    p.vx = (avgDx / dt) * 1000;
    p.vy = (avgDy / dt) * 1000;
  }

  private onEnded(s: RawTouch): void {
    const p = this.phase;
    switch (p.kind) {
      case "oneDown":
        this.resolveTap(p, s);
        return;
      case "oneMoving":
        this.phase = { kind: "idle" };
        return;
      case "dragging":
        this.emit({ k: "drag", phase: "end", t: s.t }, "tap");
        this.phase = { kind: "idle" };
        return;
      case "twoDown":
        this.onTwoDownEnded(p, s);
        return;
      case "scrolling":
        this.endScrolling(p, s);
        return;
      case "idle":
      case "awaitingSecondTap":
      case "momentum":
        return;
    }
  }

  private resolveTap(p: Extract<Phase, { kind: "oneDown" }>, s: RawTouch): void {
    const duration = s.t - p.f.startT;
    const dist = travel(p.f.startX, p.f.startY, s.x, s.y);
    if (duration < TAP_WINDOW_MS && dist < TAP_MAX_TRAVEL) {
      this.emit({ k: "click", button: "left", t: s.t }, "select");
      this.phase = { kind: "awaitingSecondTap", sinceT: s.t };
    } else {
      this.phase = { kind: "idle" };
    }
  }

  private onTwoDownEnded(p: Extract<Phase, { kind: "twoDown" }>, s: RawTouch): void {
    const isA = p.a.id === s.id;
    const mine = isA ? p.a : p.b;
    mine.lastX = s.x;
    mine.lastY = s.y;
    mine.lastT = s.t;
    if (isA) p.aEndedAt = s.t;
    else p.bEndedAt = s.t;
    if (p.aEndedAt === null || p.bEndedAt === null) return; // still waiting on the other finger
    const distA = travel(p.a.startX, p.a.startY, p.a.lastX, p.a.lastY);
    const distB = travel(p.b.startX, p.b.startY, p.b.lastX, p.b.lastY);
    const firstDown = Math.min(p.a.startT, p.b.startT);
    const lastUp = Math.max(p.aEndedAt, p.bEndedAt);
    const isTap =
      p.downSkewOk &&
      lastUp - firstDown < TAP_WINDOW_MS &&
      distA < TWO_TAP_MAX_TRAVEL &&
      distB < TWO_TAP_MAX_TRAVEL;
    if (isTap) this.emit({ k: "click", button: "right", t: lastUp }, "impactMedium");
    this.phase = { kind: "idle" };
  }

  /**
   * `other` may still be physically down (fingers rarely lift in perfect sync). Marking it
   * ignored — rather than rebasing it into a fresh tap-eligible `oneDown` — avoids a spurious
   * click firing just because the trailing finger of a broken pair happens to lift moments later
   * within tap distance/timing of *this* moment. It becomes live again once it lifts and a new
   * finger touches down.
   */
  private endScrolling(p: Extract<Phase, { kind: "scrolling" }>, s: RawTouch): void {
    const other = p.a.id === s.id ? p.b : p.a;
    this.ignored.add(other.id);
    this.emit({ k: "scroll", dx: 0, dy: 0, phase: "ended", t: s.t });
    if (Math.hypot(p.vx, p.vy) > MOMENTUM_TRIGGER_VELOCITY) {
      this.phase = { kind: "momentum", vx: p.vx, vy: p.vy };
      this.scheduleMomentumTick();
    } else {
      this.phase = { kind: "idle" };
    }
  }

  private scheduleMomentumTick(): void {
    this.config.schedule(() => {
      this.momentumTick();
    }, MOMENTUM_TICK_MS);
  }

  private momentumTick(): void {
    const p = this.phase;
    if (p.kind !== "momentum") return;
    const vx = p.vx * MOMENTUM_DECAY;
    const vy = p.vy * MOMENTUM_DECAY;
    if (Math.hypot(vx, vy) < MOMENTUM_STOP_VELOCITY) {
      this.emit({ k: "scroll", dx: 0, dy: 0, phase: "momentumEnded", t: this.config.now() });
      this.phase = { kind: "idle" };
      return;
    }
    const raw = { dx: vx * (MOMENTUM_TICK_MS / 1000), dy: vy * (MOMENTUM_TICK_MS / 1000) };
    const { dx, dy } = applyNatural(raw.dx, raw.dy, this.config.getSettings().naturalScrolling);
    this.emit({ k: "scroll", dx, dy, phase: "momentum", t: this.config.now() });
    this.phase = { kind: "momentum", vx, vy };
    this.scheduleMomentumTick();
  }

  private onCancelled(s: RawTouch): void {
    const p = this.phase;
    switch (p.kind) {
      case "oneDown":
      case "oneMoving":
        this.phase = { kind: "idle" };
        return;
      case "dragging":
        this.emit({ k: "drag", phase: "end", t: s.t }, "tap");
        this.phase = { kind: "idle" };
        return;
      case "twoDown": {
        const isA = p.a.id === s.id;
        const other = isA ? p.b : p.a;
        const otherEndedAt = isA ? p.bEndedAt : p.aEndedAt;
        // See `endScrolling` for why a still-down partner is ignored, not rebased.
        if (otherEndedAt === null) this.ignored.add(other.id);
        this.phase = { kind: "idle" };
        return;
      }
      case "scrolling": {
        const other = p.a.id === s.id ? p.b : p.a;
        this.ignored.add(other.id);
        this.emit({ k: "scroll", dx: 0, dy: 0, phase: "ended", t: s.t });
        this.phase = { kind: "idle" };
        return;
      }
      case "idle":
      case "awaitingSecondTap":
      case "momentum":
        return;
    }
  }
}
