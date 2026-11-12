/**
 * The composer's shape (XState v5): the floating pill, or the card above the keyboard, and what
 * the finger is doing with it. `AssistantComposer` sends the field's focus and blur, the pill and
 * mic gestures, and the end of a tap dictation; it reads the card's shape and slots back.
 *
 * `opening` is the moment between a tap and the field's focus: the card opens with the keyboard's
 * rise in the same tick. If the focus never arrives the card would sit open with no keyboard, so
 * `opening` falls back to `idle` after the same grace the keyboard motion gives itself.
 *
 * The connection only gates talking (the mic and the hold); the field stays editable offline,
 * since the draft is local and only sending waits for the Mac.
 */
import { assign, setup, type ActorRefFrom, type SnapshotFrom } from "xstate";

/** A focus that has not landed by now is not coming (`keyboardMotion`'s expect timeout). */
export const OPENING_TIMEOUT_MS = 600;

export interface ComposerShapeContext {
  /** The field has focus (the keyboard is up or rising). */
  focused: boolean;
  /** Connected to the Mac: the mic and the hold work. */
  online: boolean;
}

export type ComposerShapeEvent =
  /** A tap on the pill: the card opens and the field is asked to focus. */
  | { type: "composer.tapPill" }
  | { type: "composer.focus" }
  | { type: "composer.blur" }
  /** A tap on the mic started a dictation into the field. */
  | { type: "composer.tapMic" }
  /** A press became a hold: walkie-talkie, sent on release. */
  | { type: "composer.holdStart" }
  | { type: "composer.holdEnd" }
  /** The tap dictation ended (stopped, sent, cancelled or out of words): the field is the draft again. */
  | { type: "composer.dictationLanded" }
  | { type: "composer.connection"; up: boolean };

export const composerShapeMachine = setup({
  types: {
    context: {} as ComposerShapeContext,
    events: {} as ComposerShapeEvent,
    input: {} as { online: boolean },
  },
  actions: {
    focused: assign({ focused: true }),
    blurred: assign({ focused: false }),
  },
  guards: {
    online: ({ context }) => context.online,
    focused: ({ context }) => context.focused,
  },
  delays: {
    FOCUS_TIMEOUT: OPENING_TIMEOUT_MS,
  },
}).createMachine({
  id: "composerShape",
  context: ({ input }) => ({ focused: false, online: input.online }),
  on: {
    "composer.focus": { actions: "focused" },
    "composer.blur": { actions: "blurred" },
    "composer.connection": { actions: assign({ online: ({ event }) => event.up }) },
  },
  initial: "idle",
  states: {
    idle: {
      on: {
        "composer.tapPill": "opening",
        "composer.focus": { target: "typing", actions: "focused" },
        "composer.tapMic": { guard: "online", target: "tapDictating" },
        "composer.holdStart": { guard: "online", target: "holding" },
      },
    },
    opening: {
      after: { FOCUS_TIMEOUT: "idle" },
      on: {
        "composer.focus": { target: "typing", actions: "focused" },
        "composer.blur": { target: "idle", actions: "blurred" },
        "composer.tapMic": { guard: "online", target: "tapDictating" },
        "composer.holdStart": { guard: "online", target: "holding" },
      },
    },
    typing: {
      on: {
        "composer.blur": { target: "idle", actions: "blurred" },
        "composer.tapMic": { guard: "online", target: "tapDictating" },
        "composer.holdStart": { guard: "online", target: "holding" },
      },
    },
    /** The field shows the live words; keys wait until the dictation ends. */
    tapDictating: {
      on: {
        "composer.dictationLanded": [{ guard: "focused", target: "typing" }, { target: "idle" }],
      },
    },
    /** The finger is down on the pill or the mic: the pill shows the level and "Release to send". */
    holding: {
      on: {
        "composer.holdEnd": [{ guard: "focused", target: "typing" }, { target: "idle" }],
      },
    },
  },
});

export type ComposerShapeSnapshot = SnapshotFrom<typeof composerShapeMachine>;
export type ComposerShapeActor = ActorRefFrom<typeof composerShapeMachine>;

/** The card is open (keyboard, a dictation into the field, or a hold over an open card); a draft or photos also keep it open. */
export function cardOpen(snapshot: ComposerShapeSnapshot): boolean {
  return snapshot.matches("opening") || snapshot.matches("typing") || snapshot.matches("tapDictating") || snapshot.context.focused;
}

/** The field shows a tap dictation's live words: x, level, stop and send replace the card's buttons. */
export function tapDictating(snapshot: ComposerShapeSnapshot): boolean {
  return snapshot.matches("tapDictating");
}

/** The finger is down on a hold: the pill shows the live level and "Release to send". */
export function holding(snapshot: ComposerShapeSnapshot): boolean {
  return snapshot.matches("holding");
}
