/**
 * Pure dictation state machine. No React, no expo-speech-recognition, no network — the hook
 * drives this with events observed from the recognizer and the connection, and reacts to the
 * `send` effect by calling `sendCommand`. Timers (the 1.5s "no final yet" grace period and the
 * 600ms "sent" checkmark hold) are owned here via an injected `Scheduler` so tests can control
 * time deterministically without real delays.
 */

export type DictationPhase =
  | "idle"
  | "requesting_permission"
  | "permission_denied"
  | "listening"
  | "finishing"
  | "sending"
  | "sent"
  | "error";

export type DictationEvent =
  | { type: "pressStart" }
  | { type: "permission"; granted: boolean }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "pressStop" }
  | { type: "recognizerError"; code: string }
  | { type: "sendOk" }
  | { type: "sendFailed"; code: string }
  | { type: "reset" };

export interface DictationSnapshot {
  phase: DictationPhase;
  /** Live partial transcript while listening/finishing; the sent text while sending/sent. */
  transcript: string;
  /** Set when `finishing` resolved to an empty transcript; cleared on the next `pressStart`. */
  nothingHeard: boolean;
  errorCode: string | null;
}

/** The only externally-observable side effect: hand `text` to the caller's `sendCommand`. */
export interface DictationEffect {
  type: "send";
  text: string;
}

export interface Scheduler {
  /** Schedule `callback` after `ms`; the returned function cancels it. */
  after: (ms: number, callback: () => void) => () => void;
}

export const realScheduler: Scheduler = {
  after(ms, callback) {
    const id = setTimeout(callback, ms);
    return () => {
      clearTimeout(id);
    };
  },
};

const FINISH_TIMEOUT_MS = 1500;
const SENT_HOLD_MS = 900;

function idleSnapshot(): DictationSnapshot {
  return { phase: "idle", transcript: "", nothingHeard: false, errorCode: null };
}

export interface DictationMachineOptions {
  scheduler?: Scheduler;
  onEffect?: (effect: DictationEffect) => void;
}

export class DictationMachine {
  private snapshot: DictationSnapshot = idleSnapshot();
  private readonly scheduler: Scheduler;
  private readonly onEffect: ((effect: DictationEffect) => void) | undefined;
  private cancelTimer: (() => void) | null = null;

  constructor(options: DictationMachineOptions = {}) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.onEffect = options.onEffect;
  }

  getSnapshot(): DictationSnapshot {
    return this.snapshot;
  }

  send(event: DictationEvent): void {
    this.snapshot = this.reduce(this.snapshot, event);
  }

  private armTimer(ms: number, callback: () => void): void {
    this.disarmTimer();
    this.cancelTimer = this.scheduler.after(ms, () => {
      this.cancelTimer = null;
      callback();
    });
  }

  private disarmTimer(): void {
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }

  private reduce(state: DictationSnapshot, event: DictationEvent): DictationSnapshot {
    switch (state.phase) {
      case "idle":
        if (event.type === "pressStart") {
          return { phase: "requesting_permission", transcript: "", nothingHeard: false, errorCode: null };
        }
        return state;

      case "requesting_permission":
        if (event.type === "permission") {
          if (event.granted) return { ...state, phase: "listening", transcript: "" };
          return { phase: "permission_denied", transcript: "", nothingHeard: false, errorCode: null };
        }
        if (event.type === "recognizerError") {
          return { phase: "error", transcript: "", nothingHeard: false, errorCode: event.code };
        }
        if (event.type === "reset") return idleSnapshot();
        return state;

      case "permission_denied":
        if (event.type === "pressStart") {
          return { phase: "requesting_permission", transcript: "", nothingHeard: false, errorCode: null };
        }
        if (event.type === "reset") return idleSnapshot();
        return state;

      case "listening":
        if (event.type === "partial" || event.type === "final") {
          return { ...state, transcript: event.text };
        }
        if (event.type === "pressStop") {
          const next: DictationSnapshot = { ...state, phase: "finishing" };
          this.armTimer(FINISH_TIMEOUT_MS, () => {
            this.send({ type: "final", text: this.snapshot.transcript });
          });
          return next;
        }
        if (event.type === "recognizerError") {
          this.disarmTimer();
          return { phase: "error", transcript: "", nothingHeard: false, errorCode: event.code };
        }
        if (event.type === "reset") {
          this.disarmTimer();
          return idleSnapshot();
        }
        return state;

      case "finishing":
        if (event.type === "partial") {
          return { ...state, transcript: event.text };
        }
        if (event.type === "final") {
          this.disarmTimer();
          const text = event.text.trim();
          if (text.length === 0) {
            return { phase: "idle", transcript: "", nothingHeard: true, errorCode: null };
          }
          this.onEffect?.({ type: "send", text });
          return { phase: "sending", transcript: text, nothingHeard: false, errorCode: null };
        }
        if (event.type === "recognizerError") {
          this.disarmTimer();
          return { phase: "error", transcript: "", nothingHeard: false, errorCode: event.code };
        }
        if (event.type === "reset") {
          this.disarmTimer();
          return idleSnapshot();
        }
        return state;

      case "sending":
        if (event.type === "sendOk") {
          const next: DictationSnapshot = { ...state, phase: "sent" };
          this.armTimer(SENT_HOLD_MS, () => {
            this.send({ type: "reset" });
          });
          return next;
        }
        if (event.type === "sendFailed") {
          return { phase: "error", transcript: state.transcript, nothingHeard: false, errorCode: event.code };
        }
        if (event.type === "reset") {
          this.disarmTimer();
          return idleSnapshot();
        }
        return state;

      case "sent":
        if (event.type === "reset") {
          this.disarmTimer();
          return idleSnapshot();
        }
        return state;

      case "error":
        if (event.type === "reset") {
          this.disarmTimer();
          return idleSnapshot();
        }
        return state;
    }
  }
}
