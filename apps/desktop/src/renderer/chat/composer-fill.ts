import { createStore } from 'zustand/vanilla'

/**
 * Text another surface (the context popover's Commit & push) puts into a pane's composer for
 * Isaac to read and send himself. The composer takes it once and clears it; it never sends.
 */
export const composerFillStore = createStore<{ fills: Record<string, string> }>(() => ({
  fills: {},
}))

export function fillComposer(paneId: string, text: string): void {
  composerFillStore.setState((s) => ({ fills: { ...s.fills, [paneId]: text } }))
}

/** The pending text for `paneId`, removed from the store. */
export function takeComposerFill(paneId: string): string | null {
  const text = composerFillStore.getState().fills[paneId]
  if (text === undefined) return null
  composerFillStore.setState((s) => {
    const { [paneId]: _gone, ...rest } = s.fills
    return { fills: rest }
  })
  return text
}
