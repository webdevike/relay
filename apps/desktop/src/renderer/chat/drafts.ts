import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { invoke } from '../ipc'

/**
 * Composer drafts per chat key (see draftKeyFor), mirrored from main's drafts.json so they
 * survive a restart. Every change goes to main at once; main batches the disk writes.
 */
interface DraftsState {
  loaded: boolean
  texts: Record<string, string>
}

export const draftsStore = createStore<DraftsState>(() => ({ loaded: false, texts: {} }))

let loading: Promise<void> | null = null

/** Reads main's saved drafts once; later calls return the same load. */
export function loadDrafts(): Promise<void> {
  loading ??= invoke('drafts.load', {}).then((r) => {
    const saved = r.ok ? Object.fromEntries(r.value.drafts.map((d) => [d.key, d.text])) : {}
    draftsStore.setState((s) => ({ loaded: true, texts: { ...saved, ...s.texts } }))
  })
  return loading
}

export function useDraftsLoaded(): boolean {
  return useStore(draftsStore, (s) => s.loaded)
}

export function draftText(key: string): string {
  return draftsStore.getState().texts[key] ?? ''
}

/** Records a chat's draft (empty forgets it) and sends the change to main. */
export function saveDraft(key: string, text: string): void {
  const { texts } = draftsStore.getState()
  if ((texts[key] ?? '') === text) return
  const next = { ...texts }
  if (text === '') delete next[key]
  else next[key] = text
  draftsStore.setState({ texts: next })
  void invoke('drafts.save', { key, text })
}

/**
 * The key a composer draft is saved under: the chat's session file, or for a new chat without
 * one the draft app tab's scope (`draft:<tab id>`, as browserScope names it). Null while the pane
 * shows neither (nothing is saved then).
 */
export function draftKeyFor(
  pane: { file: string } | undefined,
  placeChat: string | null,
  draftScope: string,
): string | null {
  if (!pane) return null
  if (pane.file !== '') return pane.file
  return placeChat === 'draft' ? draftScope : null
}

export function resetDraftsForTests(): void {
  loading = null
  draftsStore.setState({ loaded: false, texts: {} })
}
