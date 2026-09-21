/**
 * Dictation statechart (XState v5): the single source of truth for the whole hold-to-talk
 * interaction. Pure: no React, no expo-speech-recognition, no network.
 *
 * Two parallel regions share the same events:
 *
 *   speech  the pipeline: permission → listening → finishing → sending → sent, or error; a swipe
 *           left while listening detours through choosing (the skill wheel) → chosen → idle with
 *           the skill armed for the next hold
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
 *   deliver          sending → resolves when the host acked the insert (+ Return when `submit`)
 */
import {
  and,
  assign,
  fromCallback,
  fromPromise,
  or,
  sendTo,
  setup,
  stateIn,
  type SnapshotFrom,
} from "xstate";

export type DictationPhase =
  | "idle"
  | "requesting_permission"
  | "permission_denied"
  | "listening"
  /** The skill wheel is open under the still-held finger; nothing is being heard. */
  | "choosing"
  /** The finger lifted on the wheel: the centered entry is armed; the wheel is locking onto it. */
  | "chosen"
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
  /** The flick up in the inbox arrived while listening: deliver as a new session, not a reply. */
  launching: boolean;
  /** The finger lifted before listening opened; the dictation ends as soon as it does. */
  released: boolean;
  /**
   * Slash command the dictation is pointed at (e.g. `/skill:hallmark`, `/handoff`). Armed by the wheel and kept
   * through idle and the next dictation until it is delivered, the wheel is closed on the x, or a send/error resets.
   */
  skill: string | null;
  /** While choosing: the command whose subcommands the wheel is showing (`/goal`), or null at the top ring. */
  wheelParent: string | null;
  /**
   * Images pasted from the clipboard while idle, waiting to go out with the next dictation (or on their own
   * with `sendAttachments`). Cleared once delivered, on an error, or on a reset.
   */
  images: PendingImage[];
  /** Text pasted from the clipboard while idle; goes under the dictation on the next send, or alone. */
  pasted: string | null;
}

/** A clipboard image ready for `agent.reply`: base64 with no data-URI prefix. */
export interface PendingImage {
  mimeType: "image/jpeg" | "image/png";
  data: string;
  width: number;
  height: number;
}

/** Most images one reply carries; a paste past this is ignored. */
export const MAX_PENDING_IMAGES = 4;

export type DictationEvent =
  | { type: "pressStart" }
  /** Finger crossed the send threshold: stop listening and submit (insert + Return). */
  | { type: "pressStop"; submit?: boolean }
  /** Finger lifted. While listening this ends the dictation; after a submit it launches the orb. */
  | { type: "release" }
  /** Finger flew up while listening in the inbox: finish the dictation, the orb launches, a session starts with what was heard. */
  | { type: "launch" }
  /** Finger swiped left while listening: drop what was heard and open the skill wheel. */
  | { type: "wheelOpen" }
  /**
   * Finger lifted on the wheel: the centered entry is the choice; `skill` is its slash command. `submit` means
   * the command is complete on its own: it is sent right away instead of armed.
   */
  | { type: "wheelSelect"; skill: string; submit?: boolean }
  /** Finger flicked up on an entry with subcommands: show them. `parent` is the entry's command. */
  | { type: "wheelDescend"; parent: string }
  /** Finger flicked down inside a subcommand ring: back to the top ring. */
  | { type: "wheelAscend" }
  /** Finger slid onto the close target: shut the wheel, nothing picked, nothing armed. */
  | { type: "wheelClose" }
  /** Picked from the session sheet while idle: point the next dictation at `skill`, or clear it with null. */
  | { type: "arm"; skill: string | null }
  /** A clipboard image pasted while idle: attached to the next send. Ignored past `MAX_PENDING_IMAGES`. */
  | { type: "attach"; image: PendingImage }
  | { type: "detach"; index: number }
  /** Clipboard text pasted while idle: attached to the next send (replaces an earlier paste); null drops it. */
  | { type: "attachText"; text: string | null }
  /** Send the attachments on their own: the pasted text, if any, as a submitted turn with the images. */
  | { type: "sendAttachments" }
  /** Text typed on the keyboard while idle: sent as a submitted turn, with whatever is armed or attached. */
  | { type: "typed"; text: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "recognizerEnd" }
  | { type: "recognizerError"; code: string }
  | { type: "reset" };

export type PermissionOutcome = "granted" | "denied" | "unavailable";

/** Events the recognizer actor reports to the machine. */
export type RecognizerEvent = Extract<
  DictationEvent,
  { type: "partial" | "final" | "recognizerEnd" | "recognizerError" }
>;
/** Commands the machine sends to the recognizer actor. */
export interface RecognizerCommand {
  type: "stop";
}

export interface DeliverInput {
  text: string;
  submit: boolean;
  skill: string | null;
  images: PendingImage[];
  pasted: string | null;
  /** The flick up in the inbox: this dictation starts a new session instead of replying to one. */
  launch: boolean;
}

export const FINISH_TIMEOUT_MS = 1500;
export const SENT_HOLD_MS = 900;
export const ERROR_HOLD_MS = 2500;
export const NOTHING_HEARD_HOLD_MS = 1500;
/** Orb launch: from lifted to off the top of the screen. */
export const ORB_FLIGHT_MS = 620;
/** Orb exit fade (after the check, an error, or a reset). */
export const ORB_FADE_MS = 180;

function notProvided(name: string): never {
  throw new Error(`dictation actor "${name}" not provided`);
}

const fresh: DictationContext = {
  transcript: "",
  nothingHeard: false,
  errorCode: null,
  submit: false,
  released: false,
  skill: null,
  launching: false,
  wheelParent: null,
  images: [],
  pasted: null,
};

/** `fresh`, keeping what idle carries into the next dictation: the armed skill and the attachments. */
const keepArmed = {
  ...fresh,
  skill: ({ context }: { context: DictationContext }) => context.skill,
  images: ({ context }: { context: DictationContext }) => context.images,
  pasted: ({ context }: { context: DictationContext }) => context.pasted,
};

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
    hasAttachments: ({ context }) => context.images.length > 0 || context.pasted !== null,
    submitting: ({ event }) => event.type === "pressStop" && event.submit === true,
    released: ({ context }) => context.released,
    launching: ({ context }) => context.launching,
    noSpeech: ({ event }) => event.type === "recognizerError" && event.code === "no-speech",
    listening: stateIn({ speech: { active: "listening" } }),
    speechActive: stateIn({ speech: "active" }),
    speechChoosing: or([stateIn({ speech: "choosing" }), stateIn({ speech: "chosen" })]),
    speechSent: stateIn({ speech: "sent" }),
    speechIdle: stateIn({ speech: "idle" }),
    speechError: stateIn({ speech: "error" }),
  },
  delays: {
    FINISH_TIMEOUT: FINISH_TIMEOUT_MS,
    SENT_HOLD: SENT_HOLD_MS,
    ERROR_HOLD: ERROR_HOLD_MS,
    NOTHING_HEARD_HOLD: NOTHING_HEARD_HOLD_MS,
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
          on: {
            pressStart: { target: "requesting_permission", actions: assign(keepArmed) },
            arm: { actions: assign({ skill: ({ event }) => event.skill }) },
            attach: {
              guard: ({ context }) => context.images.length < MAX_PENDING_IMAGES,
              actions: assign({ images: ({ context, event }) => [...context.images, event.image] }),
            },
            detach: {
              actions: assign({
                images: ({ context, event }) => context.images.filter((_, i) => i !== event.index),
              }),
            },
            attachText: { actions: assign({ pasted: ({ event }) => event.text }) },
            sendAttachments: {
              guard: "hasAttachments",
              target: "sending",
              actions: assign({ transcript: "", submit: true }),
            },
            typed: {
              guard: ({ event }) => event.text.trim() !== "",
              target: "sending",
              actions: assign({ transcript: ({ event }) => event.text.trim(), submit: true }),
            },
          },
        },
        requesting_permission: {
          // The finger may lift before the check lands; listening then ends as soon as it opens.
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
              {
                target: "error",
                actions: assign({ ...fresh, errorCode: ({ event }) => event.code }),
              },
            ],
          },
          states: {
            listening: {
              // Hold-to-talk only: the finger lifting always ends the dictation, however short the
              // press. A release that landed during the permission wait ends it the moment it opens.
              always: { guard: "released", target: "finishing", actions: "stopRecognizer" },
              on: {
                partial: { actions: assign({ transcript: ({ event }) => event.text }) },
                final: { actions: assign({ transcript: ({ event }) => event.text }) },
                pressStop: {
                  target: "finishing",
                  actions: [
                    assign({ submit: ({ event }) => event.submit === true }),
                    "stopRecognizer",
                  ],
                },
                release: { target: "finishing", actions: "stopRecognizer" },
                wheelOpen: {
                  target: "#dictation.speech.choosing",
                  actions: assign({ transcript: "", wheelParent: null }),
                },
                launch: { target: "finishing", actions: [assign({ launching: true }), "stopRecognizer"] },
                // A press here means the earlier release was lost: treat it as that release.
                pressStart: { target: "finishing", actions: "stopRecognizer" },
                recognizerEnd: {
                  target: "#dictation.speech.error",
                  actions: assign({ ...fresh, errorCode: "aborted" }),
                },
              },
            },
            finishing: {
              after: { FINISH_TIMEOUT: { target: "#dictation.speech.finished" } },
              on: {
                partial: { actions: assign({ transcript: ({ event }) => event.text }) },
                final: {
                  target: "#dictation.speech.finished",
                  actions: assign({ transcript: ({ event }) => event.text }),
                },
                recognizerEnd: { target: "#dictation.speech.finished" },
              },
            },
          },
        },
        /** Wheel open under the finger. The recognizer is stopped; the x or a bare release is a cancel. */
        choosing: {
          on: {
            wheelSelect: [
              {
                guard: ({ event }) => event.submit === true,
                target: "sending",
                actions: assign({ ...keepArmed, skill: ({ event }) => event.skill, submit: true }),
              },
              {
                target: "chosen",
                actions: assign({ skill: ({ event }) => event.skill, wheelParent: null }),
              },
            ],
            wheelDescend: { actions: assign({ wheelParent: ({ event }) => event.parent }) },
            wheelAscend: { actions: assign({ wheelParent: null }) },
            release: { target: "idle", actions: assign(fresh) },
            wheelClose: { target: "idle", actions: assign(fresh) },
            pressStart: { target: "idle", actions: assign(fresh) },
          },
        },
        /** Entry picked; the release that follows lands in idle with the skill armed. */
        chosen: {
          on: {
            release: { target: "idle", actions: assign(keepArmed) },
            pressStart: { target: "idle", actions: assign(keepArmed) },
          },
        },
        /** Transient: route the finished transcript to `sending` or back to `idle` (nothing heard). */
        finished: {
          always: [
            {
              guard: "hasText",
              target: "sending",
              actions: assign({ transcript: ({ context }) => context.transcript.trim() }),
            },
            // A flick with nothing heard still starts a session, just an empty one.
            { guard: "launching", target: "sending", actions: assign({ transcript: "" }) },
            { target: "idle", actions: assign({ ...keepArmed, nothingHeard: true }) },
          ],
        },
        sending: {
          invoke: {
            src: "deliver",
            input: ({ context }) => ({
              text: context.transcript,
              submit: context.submit,
              skill: context.skill,
              images: context.images,
              pasted: context.pasted,
              launch: context.launching,
            }),
            // The attachments leave with the delivery, whichever way it lands; the text and skill linger for the check.
            onDone: { target: "sent", actions: assign({ images: [], pasted: null }) },
            onError: {
              target: "error",
              actions: assign({
                errorCode: ({ event }) => ackErrorCode(event.error),
                submit: false,
                images: [],
                pasted: null,
              }),
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
            launch: { guard: "listening", target: "flying" },
          },
          always: [
            { guard: "speechSent", target: "collapsing" },
            { guard: "speechIdle", target: "fading" },
            { guard: "speechError", target: "fading" },
            { guard: "speechChoosing", target: "fading" },
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
  if (typeof speech === "object")
    return typeof speech.active === "object" ? "listening" : speech.active;
  return speech === "finished" ? "sending" : speech;
}

export function orbOf(snapshot: DictationActorSnapshot): OrbState {
  return snapshot.value.orb;
}
