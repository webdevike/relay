// What the Studio landing remembers on this device: the open view, the selection, filters, the
// create bar's settings, toasts and the one modal. Everything else (projects, favorites, trash,
// references) lives on the host and arrives through studio-store.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { STUDIO_UNSORTED, type StudioAspect } from '@evaos/contract'

/** `all`, `fav`, STUDIO_UNSORTED or a project id. */
export type StudioViewId = string
export const VIEW_ALL = 'all'
export const VIEW_FAV = 'fav'

export type DateFilter = 'all' | 'today' | 'week'

export interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

export type ModalSpec =
  | {
      kind: 'name'
      title: string
      initial: string
      cta: string
      placeholder?: string
      onSubmit: (name: string) => void
    }
  | {
      kind: 'confirm'
      title: string
      body: string
      cta: string
      danger?: boolean
      onConfirm: () => void
    }

export interface ComposerState {
  prompt: string
  /** A CreateChoice key (create-models.ts). */
  choice: string
  aspect: StudioAspect
  count: number
  seedMode: 'random' | 'fixed'
  seed: number
  /** Steps, when the picked model has a `steps` input; null leaves the model's default. */
  steps: number | null
  /** `auto` follows the open project; else STUDIO_UNSORTED or a project id. */
  dest: string
  /** Picked with @: saved reference asset ids or library image asset ids, in order. */
  refs: string[]
  /** Bumped to move focus into the prompt. */
  focus: number
}

export interface LocalState {
  view: StudioViewId
  selected: string[]
  anchor: string | null
  selectMode: boolean
  query: string
  models: string[]
  favOnly: boolean
  date: DateFilter
  toasts: Toast[]
  modal: ModalSpec | null
  dragging: boolean
  /** The image open in the editor, null for the grid. */
  editing: string | null
  composer: ComposerState
}

export const FILTERS = {
  query: '',
  models: [] as string[],
  favOnly: false,
  date: 'all' as DateFilter,
}

export const INITIAL_COMPOSER: ComposerState = {
  prompt: '',
  choice: 'moss:moss-image',
  aspect: '1:1',
  count: 1,
  seedMode: 'random',
  seed: 0,
  steps: null,
  dest: 'auto',
  refs: [],
  focus: 0,
}

const initial = (): LocalState => ({
  view: VIEW_ALL,
  selected: [],
  anchor: null,
  selectMode: false,
  ...FILTERS,
  toasts: [],
  modal: null,
  dragging: false,
  editing: null,
  composer: INITIAL_COMPOSER,
})

export const localStore = createStore<LocalState>(initial)

export function useLocal<T>(selector: (s: LocalState) => T): T {
  return useStore(localStore, selector)
}

export function setComposer(patch: Partial<ComposerState>): void {
  localStore.setState((s) => ({ composer: { ...s.composer, ...patch } }))
}

export function setSelected(ids: string[], anchor?: string | null): void {
  localStore.setState((s) => ({
    selected: ids,
    anchor: anchor === undefined ? s.anchor : anchor,
  }))
}

export function clearSelection(): void {
  localStore.setState({ selected: [], anchor: null, selectMode: false })
}

/** Opens a view: the selection never carries over. */
export function openView(view: StudioViewId): void {
  localStore.setState({ view, selected: [], anchor: null, selectMode: false })
}

export function openModal(modal: ModalSpec | null): void {
  localStore.setState({ modal })
}

/** The project a create lands in: the picked one, else the open project, else Unsorted. */
export function destinationOf(
  s: Pick<LocalState, 'view' | 'composer'>,
  projectIds: readonly string[],
): string {
  const auto = projectIds.includes(s.view) ? s.view : STUDIO_UNSORTED
  const dest = s.composer.dest
  if (dest === 'auto') return auto
  return dest === STUDIO_UNSORTED || projectIds.includes(dest) ? dest : auto
}

/** Test seam. */
export function resetLocalForTests(): void {
  localStore.setState(initial(), true)
}
