import { createContext, useContext } from 'react'

/** What a card's own buttons need from the open board. */
export interface BoardActions {
  slug: string
  /** Turns a suggestion into a note in its place, linked from whatever linked to it. */
  acceptSuggestion: (id: string) => void
  /** Removes one node and its edges, as one undo step. */
  removeNode: (id: string) => void
}

export const BoardContext = createContext<BoardActions | null>(null)

export function useBoardActions(): BoardActions {
  const actions = useContext(BoardContext)
  if (!actions) throw new Error('canvas cards render inside a board')
  return actions
}
