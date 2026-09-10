/**
 * Dictation statechart (XState v5): the single source of truth for the whole hold-to-talk
 * interaction. Pure: no React, no expo-speech-recognition, no network.
 *
 * Two parallel regions share the same events:
 *
 *   speech  the pipeline: permission → listening → finishing → sending → sent, or error
 *   orb     what the centered orb is doing: shown while listening, lifted once the finger has
 *           crossed the send threshold, flying after the finger lets go, collapsing into the check
 *           after a plain send, fading out, gone
 *
 * `orb` follows `speech` through `stateIn` guards, and owns the presentation timings (flight,
 * fade), so a component only renders the current orb state. Side effects are invoked actors that
 * the runtime (`actor.ts`) provides and tests stub:
 *
 *   checkPermission  requesting_permission → granted | denied | unavailable
 *   recognizer       runs for the whole `active` state; reports partial/final/recognizerEnd/
 *                    recognizerError; receives `stop`
 *   deliver          sending → resolves when the Mac acked the insert (+ Return when `submit`)
 */
import { and, assign, fromCallback, fromPromise, sendTo, setup, stateIn, type SnapshotFrom } from "xstate";

export type DictationPhase =
  | "idle"
  | "requesting_permission"
  | "permission_denied"
  | "listening"
  | "finishing"
  | "sending"
  | "sent"
  | "error";

export type OrbState =
  | "hidden"
  /** Breathing with the mic; rises live with the finger. */
  | "shown"
  /** Finger crossed the send threshold and is still down: held at full lift. */
  | "lifted"
  /** Finger let go after a submit: launching off the top of the screen. */
  | "flying"
  /** Plain send delivered: collapsing into the check. */
  | "collapsing"
  | "fading"
  /** Flew away; stays out of the way until the pipeline is back at idle. */
  | "gone";

export interface DictationContext {
  /** Live partial transcript while listening/finishing; the sent text while sending/sent. */
  transcript: string;
  /** Set when `finishing` resolved to an empty transcript; cleared after a hold or on the next press. */
  nothingHeard: boolean;
  errorCode: string | null;
  /** Whether the pending/last send also submits (Return) on the Mac. */
  submit: boolean;
  /** The finger has been down longer than the tap window (counted from the press, permission wait included). */
  held: boolean;
  /** The finger lifted before listening opened; resolved once listening starts. */
  released: boolean;
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
/** A press released within this window is a tap (hands-free), not a hold. */
export const TAP_WINDOW_MS = 250;
/** Orb launch: from lifted to off the top of the screen. */
export const ORB_FLIGHT_MS = 620;
/** Orb exit fade (after the check, an error, or a reset). */
export const ORB_FADE_MS = 180;

function notProvided(name: string): never {
  throw new Error(`dictation actor "${name}" not provided`);
}

const fresh: DictationContext = { transcript: "", nothingHeard: false, errorCode: null, submit: false, held: false, released: false };

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
    submitting: ({ event }) => event.type === "pressStop" && event.submit === true,
    /** A tap: the finger was up before the tap window ran out. */
    tapped: ({ context }) => context.released && !context.held,
    /** A hold that ended while permission was still being checked: nothing more to listen for. */
    releasedAfterHold: ({ context }) => context.released && context.held,
    held: ({ context }) => context.held,
    noSpeech: ({ event }) => event.type === "recognizerError" && event.code === "no-speech",
    listening: stateIn({ speech: { active: "listening" } }),
    speechActive: stateIn({ speech: "active" }),
    speechSent: stateIn({ speech: "sent" }),
    speechIdle: stateIn({ speech: "idle" }),
    speechError: stateIn({ speech: "error" }),
  },
  delays: {
    FINISH_TIMEOUT: FINISH_TIMEOUT_MS,
    SENT_HOLD: SENT_HOLD_MS,
    ERROR_HOLD: ERROR_HOLD_MS,
    NOTHING_HEARD_HOLD: NOTHING_HEARD_HOLD_MS,
    TAP_WINDOW: TAP_WINDOW_MS,
    ORB_FLIGHT: ORB_FLIGHT_MS,
    ORB_FADE: ORB_FADE_MS,
  },
}).createMachine({
  id: "dictation",
  context: fresh,
  type: "parallel",
  on: {
    reset: { target: ".speech.idle", actions: assign(fresh) },
  },
  states: {
    speech: {
      initial: "idle",
      states: {
        idle: {
          after: { NOTHING_HEARD_HOLD: { actions: assign({ nothingHeard: false }) } },
          on: { pressStart: { target: "requesting_permission", actions: assign(fresh) } },
        },
        requesting_permission: {
          // The tap window runs from the press itself, so a slow permission check cannot turn a
          // hold-and-release into a tap; whether the finger lifted meanwhile is resolved once
          // listening opens.
          after: { TAP_WINDOW: { actions: assign({ held: true }) } },
          on: { release: { actions: assign({ released: true }) } },
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
            recognizerError: [
              // Stopping before anything was said is "nothing heard", not a failure.
              { guard: "noSpeech", target: "finished" },
              { target: "error", actions: assign({ ...fresh, errorCode: ({ event }) => event.code }) },
            ],
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
                recognizerEnd: { target: "#dictation.speech.error", actions: assign({ ...fresh, errorCode: "aborted" }) },
              },
              initial: "deciding",
              states: {
                /** Transient: what the finger did during the permission wait decides how listening opens. */
                deciding: {
                  always: [
                    { guard: "tapped", target: "handsFree" },
                    { guard: "releasedAfterHold", target: "#dictation.speech.active.finishing", actions: "stopRecognizer" },
                    { guard: "held", target: "held" },
                    { target: "holding" },
                  ],
                },
                /** Finger down since the press; a release this early is a tap. */
                holding: {
                  after: { TAP_WINDOW: { target: "held", actions: assign({ held: true }) } },
                  on: { release: { target: "handsFree" } },
                },
                /** Hold-to-talk: the finger lifting ends the dictation. */
                held: {
                  on: {
                    release: { target: "#dictation.speech.active.finishing", actions: "stopRecognizer" },
                    // A press here means the earlier release was lost: treat it as that release.
                    pressStart: { target: "#dictation.speech.active.finishing", actions: "stopRecognizer" },
                  },
                },
                /** Listening with the finger up; the next tap (its release) ends the dictation. */
                handsFree: {
                  on: { release: { target: "#dictation.speech.active.finishing", actions: "stopRecognizer" } },
                },
              },
            },
            finishing: {
              after: { FINISH_TIMEOUT: { target: "#dictation.speech.finished" } },
              on: {
                partial: { actions: assign({ transcript: ({ event }) => event.text }) },
                final: { target: "#dictation.speech.finished", actions: assign({ transcript: ({ event }) => event.text }) },
                recognizerEnd: { target: "#dictation.speech.finished" },
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
    },
    orb: {
      initial: "hidden",
      states: {
        hidden: {
          always: { guard: "speechActive", target: "shown" },
        },
        shown: {
          on: {
            pressStop: { guard: and(["submitting", "listening"]), target: "lifted" },
          },
          always: [
            { guard: "speechSent", target: "collapsing" },
            { guard: "speechIdle", target: "fading" },
            { guard: "speechError", target: "fading" },
          ],
        },
        lifted: {
          // Holds through the send: the finger decides when it flies. Nothing to launch if the
          // pipeline already failed or found nothing to send.
          on: {
            release: [
              { guard: "speechIdle", target: "fading" },
              { guard: "speechError", target: "fading" },
              { target: "flying" },
            ],
          },
        },
        flying: {
          after: { ORB_FLIGHT: { target: "gone" } },
        },
        collapsing: {
          always: { guard: "speechIdle", target: "fading" },
        },
        fading: {
          after: { ORB_FADE: { target: "hidden" } },
          // A new dictation during the fade-out brings the orb straight back.
          always: { guard: "speechActive", target: "shown" },
        },
        gone: {
          always: { guard: "speechIdle", target: "hidden" },
        },
      },
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
  const speech = snapshot.value.speech;
  if (typeof speech === "object") return typeof speech.active === "object" ? "listening" : speech.active;
  return speech === "finished" ? "sending" : speech;
}

export function orbOf(snapshot: DictationActorSnapshot): OrbState {
  return snapshot.value.orb;
}
