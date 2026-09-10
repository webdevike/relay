// Port of PointerModel.swift minus what Linux does not need: uinput emits *relative* motion, so
// there is no cursor position to clamp, and click streaks (double/triple click) are counted by
// the toolkit from event timing, not carried on the event. What stays: the acceleration curve
// with sub-pixel carry, drag state, and sub-pixel scroll carry.

export const BASE_GAIN = 1.2;
export const GAIN_SLOPE = 4 / 3;
export const MAX_GAIN = 3.5;

export interface Delta {
  readonly dx: number;
  readonly dy: number;
}

/** Gain for a raw speed (points/ms), clamped to `[1, MAX_GAIN]`. ~0.6 pt/ms gives ~2x. */
export function gainForSpeed(speed: number): number {
  return Math.min(Math.max(BASE_GAIN + GAIN_SLOPE * speed, 1), MAX_GAIN);
}

export class PointerModel {
  private remainderX = 0;
  private remainderY = 0;
  private scrollRemainderX = 0;
  private scrollRemainderY = 0;
  private draggingState = false;

  get dragging(): boolean {
    return this.draggingState;
  }

  /** Raw phone delta -> accelerated integer screen delta; the fractional remainder carries over. */
  accelerate(dx: number, dy: number, dt: number): Delta {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { dx: 0, dy: 0 };
    const safeDt = Math.max(dt, 1 / 1000);
    const gain = gainForSpeed(Math.sqrt(dx * dx + dy * dy) / safeDt);
    const scaledX = dx * gain + this.remainderX;
    const scaledY = dy * gain + this.remainderY;
    const outX = Math.trunc(scaledX);
    const outY = Math.trunc(scaledY);
    this.remainderX = scaledX - outX;
    this.remainderY = scaledY - outY;
    return { dx: outX, dy: outY };
  }

  /** `false` when a drag is already in progress (caller must ignore). */
  beginDrag(): boolean {
    if (this.draggingState) return false;
    this.draggingState = true;
    return true;
  }

  /** `false` when no drag is in progress (caller must ignore). */
  endDrag(): boolean {
    if (!this.draggingState) return false;
    this.draggingState = false;
    return true;
  }

  /** Sub-pixel-accumulated scroll delta in pixel units. */
  scrollDelta(dx: number, dy: number): Delta {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { dx: 0, dy: 0 };
    const scaledX = dx + this.scrollRemainderX;
    const scaledY = dy + this.scrollRemainderY;
    const outX = Math.trunc(scaledX);
    const outY = Math.trunc(scaledY);
    this.scrollRemainderX = scaledX - outX;
    this.scrollRemainderY = scaledY - outY;
    return { dx: outX, dy: outY };
  }
}
