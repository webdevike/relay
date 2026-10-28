/**
 * Which face a portrait shows, from what the app knows about its thread (`MotionSignals`), and the
 * timeline that blends one state into the next. The mapping is deliberately calm: Thinking while a
 * turn runs or its reply is being written, Researching while it reads (search, fetch, files),
 * Working while other tools run, Idle otherwise (breathing and blinks), Snoozing after 30 quiet
 * minutes and Waking when the thread stirs again. Needing Isaac and failing are not faces: they are
 * words (`statusText`, which also words the face) and the status dot (`statusDot`). The other engine states stay for the playground.
 */
import type { Clip, DotTone, MotionState } from "./engine";
import { STATE_META } from "./engine";

/** What the tools a turn is running now are doing. */
export type ToolKind = "research" | "work";

export interface MotionSignals {
  /** A turn is running, its reply streaming in included. */
  running: boolean;
  /** What the turn's running tools (its own or its subagents') are doing, null when none run. */
  tool: ToolKind | null;
  /** Waiting on Isaac: an ask dialog, a permission, needs-you. */
  waiting: boolean;
  /** The last turn failed (until the next one starts). */
  failed: boolean;
  /** Epoch ms of the thread's newest activity (a message in or out), null when it has none. */
  activityAt: number | null;
}

export const IDLE_SIGNALS: MotionSignals = {
  running: false,
  tool: null,
  waiting: false,
  failed: false,
  activityAt: null,
};

// Tools that read rather than change: web search and fetches, browsing, file reads and searches,
// memory recall. Matched on the tool name a session reports (omp's, MCP's `server__tool`, Claude Code's).
const RESEARCH =
  /(^|[_\W])(web_?search|search|read|browse|fetch|grep|glob|find|ls|lookup|recall|reflect|crawl|scrape|scout)([_\W]|$)/i;

/** Whether tool `name` researches (reads, searches, fetches) or works (edits, runs commands, anything else). */
export function toolKind(name: string): ToolKind {
  // WebFetch → Web_Fetch, so camel-case names split into words too.
  return RESEARCH.test(name.trim().replace(/([a-z])([A-Z])/g, "$1_$2")) ? "research" : "work";
}

/** The status dot: orange while it needs Isaac, red after a failed turn, the accent while it runs. */
export function statusDot(s: MotionSignals): DotTone {
  if (s.waiting) return "orange";
  if (s.failed) return "red";
  return s.running ? "accent" : null;
}

const STATUS_TEXT: Partial<Record<MotionState, string>> = {
  thinking: "is thinking",
  researching: "is researching",
  working: "is working",
  snoozing: "is away",
};

/**
 * The short status line under an assistant's name (the thread header's pill, the call screen), the
 * same words on every client: needing Isaac and a failed turn win over the face, then the face's
 * own words; idle and waking say nothing.
 */
export function statusText(state: MotionState, s: MotionSignals): string | null {
  if (s.waiting) return "needs you";
  if (s.failed) return "hit a snag";
  return STATUS_TEXT[state] ?? null;
}

/** Quiet this long and the portrait snoozes. */
export const SNOOZE_MS = 30 * 60 * 1000;
const WAKE_MS = STATE_META.waking.dur * 1000;

export class Director {
  private wakeUntil = 0;
  private activityAt: number | null = null;
  private last: MotionState = "idle";

  /** The state for `signals` at epoch ms `now`. */
  next(s: MotionSignals, now: number): MotionState {
    const stirred =
      s.activityAt !== null && this.activityAt !== null && s.activityAt > this.activityAt;
    if (this.last === "snoozing" && (stirred || s.running || s.waiting))
      this.wakeUntil = now + WAKE_MS;
    this.activityAt = s.activityAt;
    this.last = this.pick(s, now);
    return this.last;
  }

  private pick(s: MotionSignals, now: number): MotionState {
    if (now < this.wakeUntil) return "waking";
    if (s.running && !s.waiting) {
      if (s.tool === "research") return "researching";
      return s.tool === "work" ? "working" : "thinking";
    }
    if (!s.running && !s.waiting && s.activityAt !== null && now - s.activityAt >= SNOOZE_MS)
      return "snoozing";
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
