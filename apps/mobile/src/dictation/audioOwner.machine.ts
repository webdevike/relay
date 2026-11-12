/**
 * Who owns the phone's audio session (XState v5). Pure: no React Native; the runtime
 * (`session.ts`) provides `handBack` and feeds the claims.
 *
 *   none        nobody is recording; the session is Relay's to leave alone
 *   dictation   Apple's recognizer took it (playAndRecord, active); its end hands it back
 *   legacyCall  a call over the socket (`callIsLive`) has it; dictation ending leaves it alone
 *   liveCall    the native live call (`liveCallIsUp`) has it; it outranks every other claim
 *
 * Claims stack by rank (live call, legacy call, dictation): whichever is up and highest owns the
 * session, so a dictation that ends under a call never deactivates the session the call runs on.
 */
import { assign, setup } from "xstate";

export interface AudioOwnerContext {
  liveCall: boolean;
  legacyCall: boolean;
  dictating: boolean;
}

export type AudioOwnerEvent =
  /** The call stores changed: whether each kind of call is up now. */
  | { type: "calls.changed"; liveCall: boolean; legacyCall: boolean }
  /** Apple's recognizer is about to take the session. */
  | { type: "dictation.started" }
  /** Apple's recognizer ended, however it ended. */
  | { type: "dictation.ended" };

export const audioOwnerMachine = setup({
  types: {
    context: {} as AudioOwnerContext,
    events: {} as AudioOwnerEvent,
  },
  actions: {
    /** Session back to playback only, deactivated: iOS keeps no recording session of Relay's. */
    handBack: () => {
      throw new Error('audio owner action "handBack" not provided');
    },
  },
  guards: {
    liveCallUp: ({ context }) => context.liveCall,
    liveCallDown: ({ context }) => !context.liveCall,
    legacyCallUp: ({ context }) => context.legacyCall,
    legacyCallDown: ({ context }) => !context.legacyCall,
    dictating: ({ context }) => context.dictating,
  },
}).createMachine({
  id: "audioOwner",
  context: { liveCall: false, legacyCall: false, dictating: false },
  initial: "none",
  on: {
    "calls.changed": {
      actions: assign({ liveCall: ({ event }) => event.liveCall, legacyCall: ({ event }) => event.legacyCall }),
    },
    "dictation.started": { actions: assign({ dictating: true }) },
    // A dictation ending under a call only drops its claim; the call keeps the session. An end with
    // no claim (a second `end`) is refused.
    "dictation.ended": { guard: "dictating", actions: assign({ dictating: false }) },
  },
  states: {
    none: {
      always: [
        { guard: "liveCallUp", target: "liveCall" },
        { guard: "legacyCallUp", target: "legacyCall" },
        { guard: "dictating", target: "dictation" },
      ],
    },
    dictation: {
      always: [
        { guard: "liveCallUp", target: "liveCall" },
        { guard: "legacyCallUp", target: "legacyCall" },
      ],
      on: { "dictation.ended": { target: "none", actions: [assign({ dictating: false }), "handBack"] } },
    },
    legacyCall: {
      always: [
        { guard: "liveCallUp", target: "liveCall" },
        // A dictation still running gets the session back through `none`.
        { guard: "legacyCallDown", target: "none" },
      ],
    },
    liveCall: {
      always: { guard: "liveCallDown", target: "none" },
    },
  },
});
