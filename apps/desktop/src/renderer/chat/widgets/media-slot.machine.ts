import { fromCallback, setup } from 'xstate'

/**
 * One chat media element's turn to load (docs/state-machines/media-slot.md): nothing loads while
 * it is away from the viewport; near it, it asks its lane's queue (media-queue.ts) for a slot and
 * waits its turn, newest message first; granted, it loads (`live`) and holds the slot until it
 * settles (loaded or failed) or `LOAD_TIMEOUT` passes, then it stays shown. An evicting element
 * (a 3D viewer, whose WebGL context is scarce) goes back to away once it is far off screen.
 * The runtime (media-slot.ts) provides `ticket` and sends the viewport events.
 */

/** `model` for 3D viewers, `media` for images and videos; each lane has its own limit. */
export type MediaLane = 'model' | 'media'

export interface MediaSlotInput {
  lane: MediaLane
  /** Higher loads first: the message's time. */
  rank: number
  /** Far off screen, it unloads (and loads again when it comes near). */
  evict: boolean
}

export type MediaSlotEvent =
  /** It came within the near margin of the viewport. */
  | { type: 'slot.near' }
  /** It left the near margin. */
  | { type: 'slot.away' }
  /** It left the far margin. */
  | { type: 'slot.far' }
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
    // The runtime asks the lane's queue: it sends `slot.granted`, and stopping it releases the slot.
    ticket: fromCallback<MediaSlotEvent, { lane: MediaLane; rank: number }>(() => {
      throw new Error('ticket not provided')
    }),
  },
  guards: {
    evicts: ({ context }) => context.evict,
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
        input: ({ context }) => ({ lane: context.lane, rank: context.rank }),
      },
      initial: 'queued',
      on: { 'slot.far': { guard: 'evicts', target: 'away' } },
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
      on: { 'slot.far': { guard: 'evicts', target: 'away' } },
    },
  },
})
