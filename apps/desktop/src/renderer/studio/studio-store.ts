import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  studioWithJob,
  studioWithout,
  type StudioAnswer,
  type StudioAsset,
  type StudioChange,
  type StudioDraft,
  type StudioPageOp,
  type StudioView,
} from '@evaos/contract'
import { invoke, on } from '../ipc'

/** What an agent asked Studio to show (studio.open): a job in the viewer, or a draft to fill in. */
export type StudioOpenRequest = { seq: number } & ({ job: string } | { draft: StudioDraft })

export interface StudioStoreState {
  view: StudioView
  /** Why the last load failed, null when it did not. */
  error: string | null
  /** The latest studio.open, until a page takes it. */
  request: StudioOpenRequest | null
}

const EMPTY: StudioView = { up: false, loaded: false, jobs: [], uploads: [], backends: [] }

export const studioStore = createStore<StudioStoreState>(() => ({
  view: EMPTY,
  error: null,
  request: null,
}))

export function useStudio<T>(selector: (s: StudioStoreState) => T): T {
  return useStore(studioStore, selector)
}

/** One change main pushed, applied to the view. */
export function applyStudioChange(change: StudioChange): void {
  studioStore.setState(({ view }) => {
    switch (change.kind) {
      case 'state':
        return { view: { ...view, ...change.state, loaded: true } }
      case 'job':
        return { view: { ...view, ...studioWithJob(view, change.job) } }
      case 'removed':
        return { view: { ...view, ...studioWithout(view, change.id) } }
      case 'status':
        return { view: { ...view, up: change.up } }
    }
  })
}

/** Asks main (and through it the host) for Studio now; a push that came first is kept. */
export async function loadStudio(): Promise<void> {
  const r = await invoke('studio.state', {})
  studioStore.setState((s) => {
    if (!r.ok) return { error: r.error.message }
    return r.value.loaded || !s.view.loaded ? { view: r.value, error: null } : { error: null }
  })
}

/** Sends one op as Isaac; resolves with the host's answer (a failed call is a refusal). */
export async function studioRequest(op: StudioPageOp): Promise<StudioAnswer> {
  const r = await invoke('studio.req', { op })
  return r.ok ? r.value : { ok: false, error: r.error.message }
}

/** An upload the host answered with, shown before its `studio.state` push arrives. */
export function keepStudioUpload(asset: StudioAsset): void {
  studioStore.setState(({ view }) =>
    view.uploads.some((u) => u.id === asset.id)
      ? {}
      : { view: { ...view, uploads: [asset, ...view.uploads] } },
  )
}

let seq = 0

/** Hands a studio.open to the Studio page (mounted now or when it next mounts). */
export function requestStudioOpen(what: { job: string } | { draft: StudioDraft }): void {
  studioStore.setState({ request: { seq: ++seq, ...what } })
}

let listeners = 0
let stop: (() => void) | null = null

/** Follows main's pushes while any Studio page is mounted, and loads it once on the first. */
export function startStudio(): () => void {
  if (listeners++ === 0) {
    stop = on('studio.changed', applyStudioChange)
    void loadStudio()
  }
  return () => {
    if (--listeners === 0) {
      stop?.()
      stop = null
    }
  }
}
