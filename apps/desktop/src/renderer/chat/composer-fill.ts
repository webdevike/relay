import { createStore } from 'zustand/vanilla'
import type { ReadImage } from './composer/image-input'

/**
 * What another surface puts into a composer for Isaac to read and send himself: text for a pane
 * (the context popover's Commit & push), images for a chat by its session file (Studio's Send to
 * chat; '' is a new chat). The composer takes each once and clears it; it never sends.
 */
export const composerFillStore = createStore<{
  fills: Record<string, string>
  images: Record<string, ReadImage[]>
}>(() => ({
  fills: {},
  images: {},
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

/** Images for the composer of the chat `file` shows ('' for a new chat), added after any waiting. */
export function fillComposerImages(file: string, images: ReadImage[]): void {
  composerFillStore.setState((s) => ({
    images: { ...s.images, [file]: [...(s.images[file] ?? []), ...images] },
  }))
}

/** The pending images for the chat `file`, removed from the store. */
export function takeComposerImages(file: string): ReadImage[] | null {
  const images = composerFillStore.getState().images[file]
  if (images === undefined) return null
  composerFillStore.setState((s) => {
    const { [file]: _gone, ...rest } = s.images
    return { images: rest }
  })
  return images
}
