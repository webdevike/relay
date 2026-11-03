import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Board, Boards } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { setBoardTitles } from '../eva/names-store'
import { invoke, on } from '../ipc'

/** The Relay host's dashboards as main last sent them; null until the first list arrives. */
export const boardsStore = createStore<{ data: Boards | null }>(() => ({ data: null }))

export function useBoards<T>(selector: (s: { data: Boards | null }) => T): T {
  return useStore(boardsStore, selector)
}

/** The slug a `board:<slug>` place shows, else null. */
export function boardSlugOf(place: Place): string | null {
  return place.page.startsWith('board:') ? place.page.slice('board:'.length) : null
}

export function boardOf(data: Boards | null, slug: string): Board | null {
  return data?.boards.find((b) => b.slug === slug) ?? null
}

function apply(data: Boards): void {
  boardsStore.setState({ data })
  setBoardTitles(Object.fromEntries(data.boards.map((b) => [b.slug, b.title])))
}

/** Loads the boards once and follows main's pushes: Relay streams every write live. */
export function startBoards(): () => void {
  const off = on('boards.changed', apply)
  void invoke('boards.list', {}).then((r) => {
    if (r.ok) apply(r.value)
  })
  return off
}
