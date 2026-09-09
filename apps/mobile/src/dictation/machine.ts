/**
 * Dictation statechart (XState v5). Pure: no React, no expo-speech-recognition, no network. The
 * three side effects are invoked actors that the runtime (`actor.ts`) provides and tests stub:
 *
 *   checkPermission  requesting_permission → granted | denied | unavailable
 *   recognizer       runs for the whole `active` state (listening + finishing); reports
 *                    partial/final/recognizerEnd/recognizerError; receives `stop`
 *   deliver          sending → resolves when the Mac acked the insert (+ Return when `submit`)
 *
 * Timers are `after` delays, so tests drive them with `SimulatedClock`.
 */
import { assign, fromCallback, fromPromise, sendTo, setup, type SnapshotFrom } from "xstate";

export type DictationPhase =
  | "idle"
  | "requesting_permission"
  | "permission_denied"
  | "listening"
  | "finishing"
  | "sending"
  | "sent"
  | "error";

export interface DictationContext {
  /** Live partial transcript while listening/finishing; the sent text while sending/sent. */
  transcript: string;
  /** Set when `finishing` resolved to an empty transcript; cleared after a hold or on the next press. */
  nothingHeard: boolean;
  errorCode: string | null;
  /** Whether the pending/last send also submits (Return) on the Mac. */
  submit: boolean;
  /** Incremented when the finger lifts after a submit; the orb launches once per increment. */
  launches: number;
}

export type DictationEvent =
  | { type: "pressStart" }
  /** Finger crossed the send threshold: stop listening and submit (insert + Return). */
  | { type: "pressStop"; submit?: boolean }
  /** Finger lifted. While listening this ends the dictation; after a submit it launches the orb. */
  | { type: "release" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "recognizerEnd" }
  | { type: "recognizerError"; code: string }
  | { type: "reset" };

export type PermissionOutcome = "granted" | "denied" | "unavailable";

/** Events the recognizer actor reports to the machine. */
export type RecognizerEvent = Extract<DictationEvent, { type: "partial" | "final" | "recognizerEnd" | "recognizerError" }>;
/** Commands the machine sends to the recognizer actor. */
export interface RecognizerCommand {
  type: "stop";
}

export interface DeliverInput {
  text: string;
  submit: boolean;
}

export const FINISH_TIMEOUT_MS = 1500;
export const SENT_HOLD_MS = 900;
export const ERROR_HOLD_MS = 2500;
export const NOTHING_HEARD_HOLD_MS = 1500;

function notProvided(name: string): never {
  throw new Error(`dictation actor "${name}" not provided`);
}

const fresh = { transcript: "", nothingHeard: false, errorCode: null, submit: false } as const;

export const dictationMachine = setup({
  types: {
    context: {} as DictationContext,
    events: {} as DictationEvent,
  },
  actors: {
    checkPermission: fromPromise<PermissionOutcome>(() => notProvided("checkPermission")),
    recognizer: fromCallback<RecognizerCommand>(() => notProvided("recognizer")),
    deliver: fromPromise<null, DeliverInput>(() => notProvided("deliver")),
  },
  actions: {
    stopRecognizer: sendTo("recognizer", { type: "stop" }),
  },
  guards: {
    hasText: ({ context }) => context.transcript.trim().length > 0,
    submitted: ({ context }) => context.submit,
  },
  delays: {
    FINISH_TIMEOUT: FINISH_TIMEOUT_MS,
    SENT_HOLD: SENT_HOLD_MS,
    ERROR_HOLD: ERROR_HOLD_MS,
    NOTHING_HEARD_HOLD: NOTHING_HEARD_HOLD_MS,
  },
}).createMachine({
  id: "dictation",
  context: { ...fresh, launches: 0 },
  initial: "idle",
  on: {
    reset: { target: ".idle", actions: assign(fresh) },
    release: { guard: "submitted", actions: assign({ launches: ({ context }) => context.launches + 1 }) },
  },
  states: {
    idle: {
      after: { NOTHING_HEARD_HOLD: { actions: assign({ nothingHeard: false }) } },
      on: { pressStart: { target: "requesting_permission", actions: assign(fresh) } },
    },
    requesting_permission: {
      invoke: {
        src: "checkPermission",
        onDone: [
          { guard: ({ event }) => event.output === "granted", target: "active" },
          { guard: ({ event }) => event.output === "denied", target: "permission_denied" },
          { target: "error", actions: assign({ errorCode: "service-not-allowed" }) },
        ],
        onError: { target: "error", actions: assign({ errorCode: "internal" }) },
      },
    },
    permission_denied: {
      on: { pressStart: { target: "requesting_permission", actions: assign(fresh) } },
    },
    active: {
      invoke: { id: "recognizer", src: "recognizer" },
      initial: "listening",
      on: {
        recognizerError: {
          target: "error",
          actions: assign({ ...fresh, errorCode: ({ event }) => event.code }),
        },
      },
      states: {
        listening: {
          on: {
            partial: { actions: assign({ transcript: ({ event }) => event.text }) },
            final: { actions: assign({ transcript: ({ event }) => event.text }) },
            pressStop: {
              target: "finishing",
              actions: [assign({ submit: ({ event }) => event.submit === true }), "stopRecognizer"],
            },
            release: { target: "finishing", actions: "stopRecognizer" },
            recognizerEnd: { target: "#dictation.error", actions: assign({ ...fresh, errorCode: "aborted" }) },
          },
        },
        finishing: {
          after: { FINISH_TIMEOUT: { target: "#dictation.finished" } },
          on: {
            partial: { actions: assign({ transcript: ({ event }) => event.text }) },
            final: { target: "#dictation.finished", actions: assign({ transcript: ({ event }) => event.text }) },
            recognizerEnd: { target: "#dictation.finished" },
          },
        },
      },
    },
    /** Transient: route the finished transcript to `sending` or back to `idle` (nothing heard). */
    finished: {
      always: [
        { guard: "hasText", target: "sending", actions: assign({ transcript: ({ context }) => context.transcript.trim() }) },
        { target: "idle", actions: assign({ ...fresh, nothingHeard: true }) },
      ],
    },
    sending: {
      invoke: {
        src: "deliver",
        input: ({ context }) => ({ text: context.transcript, submit: context.submit }),
        onDone: { target: "sent" },
        onError: {
          target: "error",
          actions: assign({ errorCode: ({ event }) => ackErrorCode(event.error), submit: false }),
        },
      },
    },
    sent: {
      after: { SENT_HOLD: { target: "idle", actions: assign(fresh) } },
    },
    error: {
      after: { ERROR_HOLD: { target: "idle", actions: assign(fresh) } },
      on: { pressStart: { target: "requesting_permission", actions: assign(fresh) } },
    },
  },
});

/** Extract the AckError-shaped `code` off a `sendCommand` rejection, falling back to "internal". */
function ackErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return "internal";
}

export type DictationActorSnapshot = SnapshotFrom<typeof dictationMachine>;

export function phaseOf(snapshot: DictationActorSnapshot): DictationPhase {
  const value = snapshot.value;
  if (typeof value === "object") return value.active;
  return value === "finished" ? "sending" : value;
}
