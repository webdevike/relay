import { assign, setup } from 'xstate'
import {
  canStep,
  currentSpot,
  emptyHistory,
  moveTo,
  refresh,
  sameSpot,
  visit,
  type NavHistory,
  type Spot,
} from './nav-history'

/**
 * The window's Back and Forward: which spots Isaac was at, and when a change of the screen is a
 * new entry rather than noise or the echo of a step. Pure: the desktop runtime
 * (renderer/navigation/nav-history.ts) feeds it the spot it reads from the stores and provides
 * `restore`, which puts the screen back at a spot. Docs: docs/state-machines/nav-history.md.
 */

export interface NavContext {
  history: NavHistory
  /** A spot seen but not yet recorded (state `settling`). */
  pending: Spot | null
  /** The last spot seen while a step was being restored (state `restoring`). */
  observed: Spot | null
}

export type NavEvent =
  /** The screen is at `spot` now (the runtime sends it when where Isaac is changed). */
  | { type: 'spot.changed'; spot: Spot }
  | { type: 'history.back' }
  | { type: 'history.forward' }
  /** The history list: go straight to entry `index`. */
  | { type: 'history.jump'; index: number }

/** A change that stays this long is a place Isaac was at; a flicker that moves on is not. */
export const NAV_SETTLE_MS = 150
/** After a step the screen takes this long to settle; spots seen meanwhile are its echo. */
export const NAV_RESTORE_MS = 300

/** The history as it stands once a pending spot is recorded. */
const committed = (c: NavContext): NavHistory =>
  c.pending ? visit(c.history, c.pending) : c.history

const stepped = (c: NavContext, event: NavEvent): NavHistory => {
  const h = committed(c)
  switch (event.type) {
    case 'history.back':
      return canStep(h, -1) ? moveTo(h, h.index - 1) : h
    case 'history.forward':
      return canStep(h, 1) ? moveTo(h, h.index + 1) : h
    case 'history.jump':
      return moveTo(h, event.index)
    default:
      return h
  }
}

export const navHistoryMachine = setup({
  types: {
    context: {} as NavContext,
    events: {} as NavEvent,
  },
  actions: {
    /** Puts the screen back at `spot` (the runtime provides it). */
    restore: (_, _params: { spot: Spot }) => {},
    setPending: assign({
      pending: ({ event }) => (event.type === 'spot.changed' ? event.spot : null),
    }),
    clearPending: assign({ pending: null }),
    /** Same place as the current entry: its details (scroll) are refreshed. */
    refreshCurrent: assign({
      history: ({ context, event }) =>
        event.type === 'spot.changed' ? refresh(context.history, event.spot) : context.history,
    }),
    recordFirst: assign({
      history: ({ context, event }) =>
        event.type === 'spot.changed' ? visit(context.history, event.spot) : context.history,
    }),
    commitPending: assign({
      history: ({ context }) => committed(context),
      pending: null,
    }),
    step: assign({
      history: ({ context, event }) => stepped(context, event),
      pending: null,
      observed: null,
    }),
    observe: assign({
      observed: ({ event }) => (event.type === 'spot.changed' ? event.spot : null),
    }),
    /** The step ended elsewhere (its tab was gone): the entry is where Isaac really is. */
    adoptObserved: assign({
      history: ({ context }) => {
        const seen = context.observed
        const cur = currentSpot(context.history)
        return seen && cur && !sameSpot(seen, cur)
          ? refresh(context.history, seen)
          : context.history
      },
      observed: null,
    }),
  },
  guards: {
    isEmpty: ({ context }) => context.history.index < 0,
    isCurrent: ({ context, event }) => {
      const cur = currentSpot(context.history)
      return event.type === 'spot.changed' && cur !== null && sameSpot(cur, event.spot)
    },
    /** The step goes somewhere once a pending spot is recorded. */
    canStep: ({ context, event }) => stepped(context, event).index !== committed(context).index,
  },
  delays: { settle: NAV_SETTLE_MS, restoreSettle: NAV_RESTORE_MS },
}).createMachine({
  id: 'navHistory',
  initial: 'watching',
  context: { history: emptyHistory(), pending: null, observed: null },
  states: {
    watching: {
      on: {
        'spot.changed': [
          { guard: 'isEmpty', actions: 'recordFirst' },
          { guard: 'isCurrent', actions: 'refreshCurrent' },
          { target: 'settling', actions: 'setPending' },
        ],
        'history.back': { guard: 'canStep', target: 'restoring', actions: 'step' },
        'history.forward': { guard: 'canStep', target: 'restoring', actions: 'step' },
        'history.jump': { guard: 'canStep', target: 'restoring', actions: 'step' },
      },
    },
    settling: {
      after: { settle: { target: 'watching', actions: 'commitPending' } },
      on: {
        'spot.changed': [
          { guard: 'isCurrent', target: 'watching', actions: ['clearPending', 'refreshCurrent'] },
          { target: 'settling', reenter: true, actions: 'setPending' },
        ],
        // A step does not wait for the settle: what Isaac was at is recorded first.
        'history.back': [
          { guard: 'canStep', target: 'restoring', actions: 'step' },
          { target: 'watching', actions: 'commitPending' },
        ],
        'history.forward': [
          { guard: 'canStep', target: 'restoring', actions: 'step' },
          { target: 'watching', actions: 'commitPending' },
        ],
        'history.jump': [
          { guard: 'canStep', target: 'restoring', actions: 'step' },
          { target: 'watching', actions: 'commitPending' },
        ],
      },
    },
    restoring: {
      entry: {
        type: 'restore',
        params: ({ context }) => ({ spot: currentSpot(context.history)! }),
      },
      after: { restoreSettle: { target: 'watching', actions: 'adoptObserved' } },
      on: {
        'spot.changed': { actions: 'observe' },
        // Another step while one settles (Cmd+Left held down) goes on from where this one landed.
        'history.back': { guard: 'canStep', target: 'restoring', reenter: true, actions: 'step' },
        'history.forward': {
          guard: 'canStep',
          target: 'restoring',
          reenter: true,
          actions: 'step',
        },
        'history.jump': { guard: 'canStep', target: 'restoring', reenter: true, actions: 'step' },
      },
    },
  },
})
