/**
 * The card stack on the composer (XState v5): what needs Isaac (open asks, the session's question
 * or approval) and what runs for the chat, as one stack of cards. It holds only the cards' ids in
 * order and which is in front; the cards themselves come from the chat's data (`CardStack.tsx`).
 *
 * - `empty`: no card, so no tab.
 * - `collapsed`: the tab on the composer shows the front card's title.
 * - `expanded`: the front card has grown up out of the tab; dots step between cards.
 *
 * A card that leaves (answered here, or resolved in the chat) moves the front to the next card that
 * stayed; the last one leaving empties the stack. `answered` names the card Isaac just answered, so
 * it leaves upward and one the chat resolved fades out instead.
 */
import { assign, setup } from 'xstate'
import { settleFront, stepFront } from '@evaos/chat-core/card-stack'

export interface CardStackContext {
  ids: readonly string[]
  front: string | null
  /** Which way the last move went: 1 forward, -1 back, 0 none (the stack changed under it). */
  dir: -1 | 0 | 1
  /** Stepping past the last card comes back to the first. */
  loop: boolean
  /** The card Isaac answered here, until it has left. */
  answered: string | null
}

export type CardStackEvent =
  | { type: 'cards.changed'; ids: readonly string[] }
  | { type: 'stack.open'; id?: string }
  | { type: 'stack.collapse' }
  | { type: 'stack.step'; by: 1 | -1 }
  | { type: 'stack.show'; id: string }
  | { type: 'card.answered'; id: string }

const toward = (ids: readonly string[], from: string | null, to: string | null): -1 | 0 | 1 =>
  Math.sign(ids.indexOf(to ?? '') - ids.indexOf(from ?? '')) as -1 | 0 | 1

export const cardStackMachine = setup({
  types: {
    input: {} as { loop: boolean; ids?: readonly string[] },
    context: {} as CardStackContext,
    events: {} as CardStackEvent,
  },
  guards: {
    stocked: ({ context }) => context.ids.length > 0,
    emptied: ({ event }) => event.type === 'cards.changed' && event.ids.length === 0,
    arrived: ({ event }) => event.type === 'cards.changed' && event.ids.length > 0,
  },
  actions: {
    settle: assign(({ context, event }) => {
      if (event.type !== 'cards.changed') return {}
      return {
        ids: event.ids,
        front: settleFront(context.ids, event.ids, context.front),
        dir: 0 as const,
        answered:
          context.answered !== null && event.ids.includes(context.answered)
            ? context.answered
            : null,
      }
    }),
    step: assign(({ context, event }) => {
      if (event.type !== 'stack.step') return {}
      return { front: stepFront(context.ids, context.front, event.by, context.loop), dir: event.by }
    }),
    show: assign(({ context, event }) => {
      const id = event.type === 'stack.show' || event.type === 'stack.open' ? event.id : undefined
      if (id === undefined || !context.ids.includes(id)) return {}
      return { front: id, dir: toward(context.ids, context.front, id) }
    }),
    markAnswered: assign(({ event }) =>
      event.type === 'card.answered' ? { answered: event.id } : {},
    ),
  },
}).createMachine({
  id: 'cardStack',
  context: ({ input }) => ({
    ids: input.ids ?? [],
    front: input.ids?.[0] ?? null,
    dir: 0,
    loop: input.loop,
    answered: null,
  }),
  initial: 'empty',
  states: {
    empty: {
      always: { guard: 'stocked', target: 'collapsed' },
      on: { 'cards.changed': { guard: 'arrived', target: 'collapsed', actions: 'settle' } },
    },
    collapsed: {
      on: {
        'cards.changed': [
          { guard: 'emptied', target: 'empty', actions: 'settle' },
          { actions: 'settle' },
        ],
        'stack.open': { target: 'expanded', actions: 'show' },
        'card.answered': { actions: 'markAnswered' },
      },
    },
    expanded: {
      on: {
        'cards.changed': [
          { guard: 'emptied', target: 'empty', actions: 'settle' },
          { actions: 'settle' },
        ],
        'stack.collapse': { target: 'collapsed' },
        'stack.step': { actions: 'step' },
        'stack.show': { actions: 'show' },
        'card.answered': { actions: 'markAnswered' },
      },
    },
  },
})
