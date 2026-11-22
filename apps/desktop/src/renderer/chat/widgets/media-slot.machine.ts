import { fromCallback, setup } from 'xstate'

/**
 * One chat image or video's turn to load (docs/state-machines/media-slot.md): nothing loads while
 * it is away from the viewport; near it, it asks the queue (media-queue.ts) for a slot and waits
 * its turn, newest message first; granted, it loads (`live`) and holds the slot until it settles
 * (loaded or failed) or `LOAD_TIMEOUT` passes, then it stays shown. 3D models do not queue: they
 * open only on a click (rich/model-viewer.machine.ts).
 * The runtime (media-slot.ts) provides `ticket` and sends the viewport events.
 */

export interface MediaSlotInput {
  /** Higher loads first: the message's time. */
  rank: number
}

export type MediaSlotEvent =
  /** It came within the near margin of the viewport. */
  | { type: 'slot.near' }
  /** It left the near margin. */
  | { type: 'slot.away' }
  /** The queue gave it a slot. */
  | { type: 'slot.granted' }
  /** Its media loaded or failed. */
  | { type: 'slot.settled' }

export const mediaSlotMachine = setup({
  types: {
    input: {} as MediaSlotInput,
    context: {} as MediaSlotInput,
    events: {} as MediaSlotEvent,
  },
  actors: {
    // The runtime asks the queue: it sends `slot.granted`, and stopping it releases the slot.
    ticket: fromCallback<MediaSlotEvent, { rank: number }>(() => {
      throw new Error('ticket not provided')
    }),
  },
  delays: {
    LOAD_TIMEOUT: 15_000,
  },
}).createMachine({
  id: 'mediaSlot',
  context: ({ input }) => input,
  initial: 'away',
  states: {
    away: {
      on: { 'slot.near': 'claimed' },
    },
    claimed: {
      invoke: {
        src: 'ticket',
        input: ({ context }) => ({ rank: context.rank }),
      },
      initial: 'queued',
      states: {
        queued: {
          on: { 'slot.granted': 'loading', 'slot.away': '#mediaSlot.away' },
        },
        loading: {
          tags: ['live'],
          on: { 'slot.settled': '#mediaSlot.shown' },
          after: { LOAD_TIMEOUT: '#mediaSlot.shown' },
        },
      },
    },
    shown: {
      tags: ['live'],
    },
  },
})
