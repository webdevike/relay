import { setup } from 'xstate'

/**
 * One card's generation state on a board an agent works (docs/state-machines/card-gen.md), the
 * pen.dev-style "an agent is making this" layer over component cards and frames. The canvas drive
 * says when the agent's canvas.add lands a card (`creating`: an empty artboard with a spinner until
 * its content first draws) and when its canvas.edit changes one (`generating`: an accent border, a
 * soft moving light and "Generating: <board> • <title>" above it). The run ending (canvas.done,
 * stopped, Isaac taking over) or a quiet spell with no edit makes it `done` (the label goes plain,
 * the light fades), which settles back to `idle`. A render that fails while the agent works is
 * `error` (the card keeps its last good render); the agent's next edit tries again.
 * The runtime (card-gen.ts) holds one actor per card and feeds it these events.
 */

export type CardGenEvent =
  /** The agent's canvas.add landed this card. */
  | { type: 'agent.added' }
  /** The agent's canvas.edit (or a child it added into this frame) changed this card. */
  | { type: 'agent.edited' }
  /** The agent's run on the board ended: canvas.done, stopped, idle, or Isaac took over. */
  | { type: 'agent.finished' }
  /** The card's content drew: a component card's page drew its code, a frame got its first card. */
  | { type: 'card.drawn' }
  /** The card's newest code did not draw (it keeps its last good render). */
  | { type: 'card.failed' }

/** The states a card shows, for the card's `data-gen` and its label. */
export type CardGenState = 'idle' | 'creating' | 'generating' | 'done' | 'error'

export const cardGenMachine = setup({
  types: { events: {} as CardGenEvent },
  delays: {
    /** No edit for this long while generating: the agent is through with the card. */
    QUIET: 30_000,
    /** A new card whose content never draws stops spinning after this long. */
    STALL: 20_000,
    /** How long the plain "done" label and the fading light stay before the card is idle. */
    SETTLE: 4_000,
  },
}).createMachine({
  id: 'cardGen',
  initial: 'idle',
  states: {
    idle: {
      on: {
        'agent.added': 'creating',
        'agent.edited': 'generating',
      },
    },
    creating: {
      tags: ['agent', 'busy'],
      on: {
        'card.drawn': 'generating',
        'card.failed': 'error',
        // An edit before the first draw keeps the spinner; the clock starts again.
        'agent.edited': { target: 'creating', reenter: true },
        'agent.finished': 'done',
      },
      after: { STALL: 'done' },
    },
    generating: {
      tags: ['agent'],
      on: {
        'agent.edited': { target: 'generating', reenter: true },
        'card.failed': 'error',
        'agent.finished': 'done',
      },
      after: { QUIET: 'done' },
    },
    error: {
      tags: ['agent'],
      on: {
        // The agent's next edit is another try; a later draw (an undo, a fix) clears it.
        'agent.edited': 'generating',
        'card.drawn': 'done',
      },
    },
    done: {
      on: {
        'agent.added': 'creating',
        'agent.edited': 'generating',
      },
      after: { SETTLE: 'idle' },
    },
  },
})
