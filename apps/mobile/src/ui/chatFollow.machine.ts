/**
 * Following the newest row of an inverted transcript (XState v5). At offset 0 the inverted list
 * grows upward from the newest row, so `following` just pins it there as content arrives. Only a
 * reader's gesture suspends that: a drag (or the flick after it) is `reading.moving` and decides
 * from the offset where it ends, near the bottom (follow again) or away (`reading.still`).
 *
 * The scroll-to-bottom button animates home (`returning`). Its end is normally a momentum-end
 * event, but an animated scroll that does not move (already at 0) sends none, so `returning`
 * also gives up waiting after a deadline and follows anyway. `centring` scrolls a chosen row to
 * the middle and remembers it (`target`), so a row the list had not laid out yet still ends up
 * centred when `useInvertedChatScroll` retries.
 *
 * Effects are named actions `useInvertedChatScroll` provides: `followNewest` (pin to 0 on the
 * next frame, if still following), `scrollHome` (to 0, animated or not) and `centreRow`.
 */
import { assign, setup, type SnapshotFrom } from "xstate";

/** Within this many points of the newest row counts as at the bottom. */
export const BOTTOM_THRESHOLD = 24;
/** Longest an animated scroll home may take before following resumes without its end event. */
export const RETURN_TIMEOUT_MS = 600;

export interface ChatFollowContext {
  /** The newest row is in view; the screen hides its scroll-to-bottom button and anchors nothing. */
  near: boolean;
  /** The row `scrollToRow` last headed for. */
  target: number | null;
}

export type ChatFollowEvent =
  | { type: "follow.dragStart" }
  | { type: "follow.dragEnd"; offset: number }
  | { type: "follow.momentumStart" }
  | { type: "follow.momentumEnd"; offset: number }
  | { type: "follow.scroll"; offset: number }
  /** Rows arrived or grew. */
  | { type: "follow.contentChanged" }
  | { type: "follow.toBottom"; animated: boolean }
  | { type: "follow.toRow"; index: number; animated: boolean };

export const chatFollowMachine = setup({
  types: {
    context: {} as ChatFollowContext,
    events: {} as ChatFollowEvent,
    input: {} as { initialOffset: number },
  },
  actions: {
    // Supplied by `useInvertedChatScroll`; nothing to do without a list.
    followNewest: () => undefined,
    scrollHome: () => undefined,
    centreRow: () => undefined,
    atBottom: assign({ near: true }),
    trackOffset: assign({
      near: ({ context, event }) => ("offset" in event ? event.offset <= BOTTOM_THRESHOLD : context.near),
    }),
    aimAt: assign(({ context, event }) => {
      if (event.type !== "follow.toRow") return {};
      // Row 0 is the newest: centring it does not take the reader away.
      return { target: event.index, near: event.index > 0 ? false : context.near };
    }),
  },
  guards: {
    startsNear: ({ context }) => context.near,
    nearBottom: ({ event }) => "offset" in event && event.offset <= BOTTOM_THRESHOLD,
    animated: ({ event }) => event.type === "follow.toBottom" && event.animated,
    validRow: ({ event }) => event.type === "follow.toRow" && event.index >= 0,
  },
  delays: {
    RETURN_TIMEOUT: RETURN_TIMEOUT_MS,
  },
}).createMachine({
  id: "chatFollow",
  context: ({ input }) => ({ near: input.initialOffset <= BOTTOM_THRESHOLD, target: null }),
  on: {
    "follow.toBottom": [
      { guard: "animated", target: ".returning", actions: "scrollHome" },
      { target: ".following", actions: "scrollHome" },
    ],
    "follow.toRow": { guard: "validRow", target: ".centring", actions: ["aimAt", "centreRow"] },
  },
  initial: "restoring",
  states: {
    /** Back on a thread: follow if it was left at the bottom, else keep the reader's place. */
    restoring: {
      always: [{ guard: "startsNear", target: "following" }, { target: "reading" }],
    },
    following: {
      entry: "atBottom",
      on: {
        "follow.contentChanged": { actions: "followNewest" },
        "follow.dragStart": "reading.moving",
        "follow.momentumStart": "reading.moving",
      },
    },
    reading: {
      initial: "still",
      states: {
        /** A finger or the flick after it; native anchoring never moves the offset here. */
        moving: {
          on: {
            "follow.scroll": { actions: "trackOffset" },
            "follow.dragEnd": [
              { guard: "nearBottom", target: "#chatFollow.following" },
              { target: "still", actions: "trackOffset" },
            ],
            "follow.momentumEnd": [
              { guard: "nearBottom", target: "#chatFollow.following", actions: "followNewest" },
              { target: "still", actions: "trackOffset" },
            ],
          },
        },
        still: {
          on: {
            "follow.dragStart": "moving",
            "follow.momentumStart": "moving",
          },
        },
      },
    },
    /** Animating home; rows that arrive meanwhile wait for the landing. */
    returning: {
      entry: "atBottom",
      after: { RETURN_TIMEOUT: { target: "following", actions: "followNewest" } },
      on: {
        "follow.momentumEnd": { target: "following", actions: "followNewest" },
        "follow.dragStart": "reading.moving",
      },
    },
    /** Heading for `target` in the middle of the list; a reader until a gesture says otherwise. */
    centring: {
      on: {
        "follow.dragStart": "reading.moving",
        "follow.momentumStart": "reading.moving",
      },
    },
  },
});

export type ChatFollowSnapshot = SnapshotFrom<typeof chatFollowMachine>;

/** The newest row is out of view: the screen shows its scroll-to-bottom button and anchors the reader's rows. */
export function awayFromBottom(snapshot: ChatFollowSnapshot): boolean {
  return !snapshot.context.near;
}
