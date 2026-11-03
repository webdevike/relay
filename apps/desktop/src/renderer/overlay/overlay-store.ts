import { useEffect, useId } from 'react'
import { createStore } from 'zustand/vanilla'
import { invoke } from '../ipc'

export interface OverlayState {
  ids: Set<string>
}

/** Every open overlay registers an id here; the native browser view hides while any exists. */
export const overlayStore = createStore<OverlayState>(() => ({ ids: new Set<string>() }))

let occluded = false
overlayStore.subscribe((s) => {
  const next = s.ids.size > 0
  if (next === occluded) return
  occluded = next
  void invoke('browser.setOccluded', { occluded: next })
})

export function addOverlay(id: string): void {
  overlayStore.setState((s) => ({ ids: new Set(s.ids).add(id) }))
}

export function removeOverlay(id: string): void {
  overlayStore.setState((s) => {
    const ids = new Set(s.ids)
    ids.delete(id)
    return { ids }
  })
}

/** Hides the browser view while `open` is true (D-08). */
export function useOccludeBrowser(open: boolean): void {
  const id = useId()
  useEffect(() => {
    if (!open) return
    addOverlay(id)
    return () => removeOverlay(id)
  }, [open, id])
}
