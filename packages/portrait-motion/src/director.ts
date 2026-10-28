/**
 * Which state a portrait shows, from what the app knows about its thread (`MotionSignals`), and the
 * timeline that blends one state into the next. Apps feed signals each tick; the director turns
 * edges into the short states: Hello when a thread opens, Done for a moment when a turn ends well,
 * Waking when a message arrives while it snoozes.
 */
import { STATE_META, type Clip, type MotionState } from "./engine";

export interface MotionSignals {
  /** A turn is running: Thinking, or Working when `working` too. */
  running: boolean;
  /** Tools, subagents or background jobs are running inside the turn. */
  working: boolean;
  /** The reply streams in, or the assistant's voice plays on a call. */
  talking: boolean;
  /** Isaac is speaking on a call. */
  listening: boolean;
  /** Waiting on Isaac: an ask dialog, a permission, needs-you. */
  waiting: boolean;
  /** The last turn failed (until the next one starts). */
  failed: boolean;
  /** Epoch ms of the thread's newest activity (a message in or out), null when it has none. */
  activityAt: number | null;
}

export const IDLE_SIGNALS: MotionSignals = {
  running: false,
  working: false,
  talking: false,
  listening: false,
  waiting: false,
  failed: false,
  activityAt: null,
};

/** How long Done shows after a turn ends well. */
export const DONE_MS = 2000;
/** Quiet this long and the portrait snoozes. */
export const SNOOZE_MS = 30 * 60 * 1000;
const HELLO_MS = STATE_META.hello.dur * 1000;
const WAKE_MS = STATE_META.waking.dur * 1000;

export class Director {
  private helloUntil: number;
  private doneUntil = 0;
  private wakeUntil = 0;
  private wasActive = false;
  private activityAt: number | null = null;
  private last: MotionState = "idle";

  /** `hello`: the thread just opened, so it greets first. */
  constructor(now: number, { hello = false }: { hello?: boolean } = {}) {
    this.helloUntil = hello ? now + HELLO_MS : 0;
  }

  /** The state for `signals` at epoch ms `now`. */
  next(s: MotionSignals, now: number): MotionState {
    const active = s.running || s.talking || s.listening;
    const stirred =
      s.activityAt !== null && this.activityAt !== null && s.activityAt > this.activityAt;
    if (this.last === "snoozing" && (stirred || active || s.waiting))
      this.wakeUntil = now + WAKE_MS;
    if (this.wasActive && !active && !s.failed && !s.waiting) this.doneUntil = now + DONE_MS;
    if (active) {
      this.doneUntil = 0;
      this.helloUntil = 0;
    }
    this.wasActive = active;
    this.activityAt = s.activityAt;
    this.last = this.pick(s, now);
    return this.last;
  }

  private pick(s: MotionSignals, now: number): MotionState {
    if (s.listening) return "listening";
    if (now < this.wakeUntil) return "waking";
    if (s.talking) return "talking";
    if (s.waiting) return "confused";
    if (s.running) return s.working ? "working" : "thinking";
    if (s.failed) return "error";
    if (now < this.helloUntil) return "hello";
    if (now < this.doneUntil) return "done";
    if (s.activityAt !== null && now - s.activityAt >= SNOOZE_MS) return "snoozing";
    return "idle";
  }
}

/** A portrait's place in time: its state, when that began, and the state it blends from. */
export class Timeline {
  private readonly origin: number;
  private since: number;
  private prev: MotionState | null = null;
  private prevDur = 0;

  constructor(
    private state: MotionState,
    now: number,
  ) {
    this.origin = now;
    this.since = now;
  }

  get current(): MotionState {
    return this.state;
  }

  /** Move to `state` at epoch ms `now` (no-op when already there). */
  set(state: MotionState, now: number): void {
    if (state === this.state) return;
    this.prev = this.state;
    this.prevDur = (now - this.since) / 1000;
    this.state = state;
    this.since = now;
  }

  /** The clip to draw at epoch ms `now`. */
  clip(now: number): Clip {
    return {
      state: this.state,
      lt: Math.max(0, now - this.since) / 1000,
      gt: (now - this.origin) / 1000,
      prev: this.prev,
      prevDur: this.prevDur,
    };
  }
}
