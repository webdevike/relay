/**
 * The cards' generation states (card-gen.machine.ts): one actor per card of a board an agent works,
 * kept outside the cards so an event the drive sends before the card mounts (its add lands in the
 * file a moment before the board reloads) still counts, and a card scrolled off and back keeps its
 * state. An idle actor holds no timer, so actors stay for the window's life. Main's drive sends
 * `added` and `edited` (board call `gen`); a run that stops working on the board (canvas.done,
 * stopped, idle, Isaac taking over) finishes every card of that board.
 */
import { useSelector } from '@xstate/react'
import { createActor, type Actor, type SnapshotFrom } from 'xstate'
import { cardGenMachine, type CardGenEvent, type CardGenState } from './card-gen.machine'
import { canvasRunsStore } from './runs-store'

type GenActor = Actor<typeof cardGenMachine>

/** slug, then card id. */
const boards = new Map<string, Map<string, GenActor>>()
/** Hear any card's state change (the cursor's spinner follows `creatingCards`). */
const listeners = new Set<() => void>()

function actorOf(slug: string, id: string): GenActor {
  let cards = boards.get(slug)
  if (!cards) {
    cards = new Map()
    boards.set(slug, cards)
  }
  let a = cards.get(id)
  if (!a) {
    a = createActor(cardGenMachine)
    a.subscribe(() => {
      for (const l of listeners) l()
    })
    a.start()
    cards.set(id, a)
  }
  watchRuns()
  return a
}

/** Sends `event` to card `id` of board `slug`. */
export function sendCardGen(slug: string, id: string, event: CardGenEvent): void {
  actorOf(slug, id).send(event)
}

/** Main's drive: the agent added (`added`) or changed (`edited`) cards `nodes` of board `slug`. */
export function cardGenCall(
  slug: string,
  nodes: readonly string[],
  phase: 'added' | 'edited',
): void {
  const event: CardGenEvent = { type: phase === 'added' ? 'agent.added' : 'agent.edited' }
  for (const id of nodes) sendCardGen(slug, id, event)
}

let unwatch: (() => void) | null = null
/**
 * Follows the runs once a card has a state: while the board's run is not working (canvas.done,
 * stopped, idle, paused by Isaac, none), its cards are finished (only active ones listen).
 */
function watchRuns(): void {
  if (unwatch) return
  unwatch = canvasRunsStore.subscribe(({ runs }) => {
    for (const [slug, cards] of boards) {
      const status = runs.find((r) => r.slug === slug)?.status
      if (status === 'working' || status === 'ask') continue
      for (const a of cards.values()) a.send({ type: 'agent.finished' })
    }
  })
}

const selectState = (s: SnapshotFrom<typeof cardGenMachine>): CardGenState =>
  s.value as CardGenState

/** Card `id`'s generation state on board `slug`. */
export function useCardGen(slug: string, id: string): CardGenState {
  return useSelector(actorOf(slug, id), selectState)
}

/** The cards of board `slug` being created (the agent's cursor on one shows a spinner). */
export function creatingCards(slug: string): string[] {
  return [...(boards.get(slug) ?? [])].flatMap(([id, a]) =>
    a.getSnapshot().hasTag('busy') ? [id] : [],
  )
}

/** Hears every change of any card's state; answers the unsubscribe. */
export function onCardGen(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
