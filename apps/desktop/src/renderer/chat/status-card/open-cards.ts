import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/**
 * Which cards are open, by card id. The transcript unmounts rows that scroll away, so an open card
 * keeps its place here, not in the component. Memory only: a reload closes every card.
 */
const store = createStore<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }))

/** Opens or closes card `id`. */
export function setCardOpen(id: string, open: boolean): void {
  const { ids } = store.getState()
  if (ids.has(id) === open) return
  const next = new Set(ids)
  if (open) next.add(id)
  else next.delete(id)
  store.setState({ ids: next })
}

/** Whether card `id` is open. */
export function useCardOpen(id: string): boolean {
  return useStore(store, (s) => s.ids.has(id))
}
