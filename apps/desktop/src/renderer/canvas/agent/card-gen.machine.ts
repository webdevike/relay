import { assign, setup } from 'xstate'

/**
 * One card's generation state on a board an agent works (docs/state-machines/card-gen.md), the
 * pen.dev-style "an agent is making this" layer over component cards and frames. The canvas drive
 * says when the agent's canvas.add lands a card (`creating`: an empty artboard with a spinner until
 * its content first draws) and when its canvas.edit changes one. The card itself says when
 * content arrives: a component card's page streams in what an edit added or changed
 * (widget-runtime stream.ts), a frame gets a card or a card in it streams. Only then is it
 * `streaming` (an accent border, a soft moving light and "Generating: <board> • <title>"), for the
 * reveal plus a short tail; between edits it is `settled` (looks as always, the agent still on it),
 * however long the run stays open. The run ending (canvas.done, stopped, Isaac taking over) or a
 * quiet spell makes it `idle`; a reveal still running finishes first. A render that fails while
 * the agent works is `error` (the card keeps its last good render); the agent's next edit tries
 * again. The runtime (card-gen.ts) holds one actor per card and feeds it these events.
 */

export type CardGenEvent =
  /** The agent's canvas.add landed this card. */
  | { type: 'agent.added' }
  /** The agent's canvas.edit (or a child it added into this frame) changed this card. */
  | { type: 'agent.edited' }
  /** The agent's run on the board ended: canvas.done, stopped, idle, or Isaac took over. */
  | { type: 'agent.finished' }
  /** The card's content drew with nothing to stream in (a frame got its first card). */
  | { type: 'card.drawn' }
  /** Content is streaming into the card; the last of it is in after `ms` (0: no motion). */
  | { type: 'card.revealed'; ms: number }
  /** The card's newest code did not draw (it keeps its last good render). */
  | { type: 'card.failed' }

/** The states a card shows, for the card's `data-gen` and its label. */
export type CardGenState = 'idle' | 'creating' | 'settled' | 'streaming' | 'error'

/** How long the light stays at least, and after the last element is in. */
const REVEAL_MIN_MS = 600
const REVEAL_TAIL_MS = 600

export const cardGenMachine = setup({
  types: { context: {} as { ms: number }, events: {} as CardGenEvent },
  actions: {
    /** Keeps how long the arriving reveal runs. */
    takeReveal: assign({
      ms: ({ event }) => (event.type === 'card.revealed' ? event.ms : 0),
    }),
  },
  delays: {
    /** No edit for this long: the agent is through with the card. */
    QUIET: 30_000,
    /** A new card whose content never draws stops spinning after this long. */
    STALL: 20_000,
    /** The reveal running (at least a moment, so a still swap is seen too), then a short tail. */
    REVEAL: ({ context }) => Math.max(context.ms, REVEAL_MIN_MS) + REVEAL_TAIL_MS,
  },
}).createMachine({
  id: 'cardGen',
  context: { ms: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        'agent.added': 'creating',
        'agent.edited': 'settled',
      },
    },
    creating: {
      tags: ['agent', 'busy'],
      on: {
        'card.revealed': { target: 'streaming', actions: 'takeReveal' },
        'card.drawn': 'settled',
        'card.failed': 'error',
        // An edit before the first draw keeps the spinner; the clock starts again.
        'agent.edited': { target: 'creating', reenter: true },
        'agent.finished': 'idle',
      },
      after: { STALL: 'idle' },
    },
    streaming: {
      tags: ['agent'],
      initial: 'open',
      on: {
        'card.failed': 'error',
      },
      states: {
        /** The run goes on: once the reveal is in, the card settles until the next edit. */
        open: {
          on: {
            // A reveal landing on a running one merges into it: the light stays to its end.
            'card.revealed': { target: 'open', reenter: true, actions: 'takeReveal' },
            'agent.finished': 'closing',
          },
          after: { REVEAL: '#cardGen.settled' },
        },
        /** The run ended mid-reveal: the reveal finishes, then the card is idle. */
        closing: {
          on: {
            'card.revealed': { target: 'closing', reenter: true, actions: 'takeReveal' },
          },
          after: { REVEAL: '#cardGen.idle' },
        },
      },
    },
    settled: {
      tags: ['agent'],
      on: {
        'card.revealed': { target: 'streaming', actions: 'takeReveal' },
        'card.failed': 'error',
        // Each edit restarts the quiet clock.
        'agent.edited': { target: 'settled', reenter: true },
        'agent.finished': 'idle',
      },
      after: { QUIET: 'idle' },
    },
    error: {
      tags: ['agent'],
      on: {
        // The agent's next edit is another try; a later draw (an undo, a fix) clears it.
        'agent.edited': 'settled',
        'card.revealed': { target: 'streaming', actions: 'takeReveal' },
        'card.drawn': 'settled',
      },
    },
  },
})
