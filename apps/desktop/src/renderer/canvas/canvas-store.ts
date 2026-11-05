import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { CanvasEntry } from '@evaos/contract'
import { placeOf, type Place } from '@evaos/shell-core'
import { setCanvasTitles } from '../eva/names-store'
import { invoke, on } from '../ipc'
import { openPlaceAt } from '../navigation/open-in-app'
import type { OpenTarget } from '../navigation/open-target'
import { registerReloader } from '../reload/reload'

export interface CanvasListState {
  /** Boards newest first; null until the first read. */
  entries: CanvasEntry[] | null
  error: boolean
  /** The board last shown on the Canvas page; the nav row reopens it (native canvas_view::select). */
  shown: string | null
}

const initial = (): CanvasListState => ({ entries: null, error: false, shown: null })

export const canvasStore = createStore<CanvasListState>(initial)

export function useCanvasList<T>(selector: (s: CanvasListState) => T): T {
  return useStore(canvasStore, selector)
}

/** Where the sidebar's Canvas row goes: the board shown last if it still exists, else the newest. */
export function canvasNavPlace(): Place {
  const { entries, shown } = canvasStore.getState()
  const keep = shown !== null && (entries === null || entries.some((e) => e.slug === shown))
  return placeOf('canvas', { canvas: keep ? shown : null })
}

/** Renames and deletes done here, so an open board takes the new title or lets go of its file. */
export type BoardOp =
  | { kind: 'renamed'; slug: string; title: string }
  | { kind: 'deleted'; slug: string }

const opListeners = new Set<(op: BoardOp) => void>()

export function onBoardOp(fn: (op: BoardOp) => void): () => void {
  opListeners.add(fn)
  return () => {
    opListeners.delete(fn)
  }
}

let inflight: Promise<void> | null = null
let queued = false

async function runOnce(): Promise<void> {
  try {
    const r = await invoke('canvas.list', {})
    if (r.ok) {
      canvasStore.setState({ entries: r.value.entries, error: false })
      setCanvasTitles(Object.fromEntries(r.value.entries.map((e) => [e.slug, e.title])))
    } else canvasStore.setState({ error: true })
  } catch {
    canvasStore.setState({ error: true })
  }
}

/** One request in flight; triggers during flight collapse into exactly one follow-up. */
export function loadCanvasList(): Promise<void> {
  if (inflight) {
    queued = true
    return inflight
  }
  inflight = (async () => {
    try {
      do {
        queued = false
        await runOnce()
      } while (queued)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export type OpResult = { ok: true } | { ok: false; message: string }

/** Creates `untitled-<n>` and shows it where `target` says. */
export async function newBoard(target: OpenTarget = 'here'): Promise<void> {
  const r = await invoke('canvas.create', {})
  await loadCanvasList()
  if (r.ok) openPlaceAt(placeOf('canvas', { canvas: r.value.slug }), target)
}

export async function renameBoard(slug: string, title: string): Promise<OpResult> {
  const name = title.trim()
  if (name === '') return { ok: false, message: 'Give the board a name.' }
  const r = await invoke('canvas.rename', { slug, title: name })
  if (!r.ok) return { ok: false, message: r.error.message }
  for (const fn of opListeners) fn({ kind: 'renamed', slug, title: name })
  await loadCanvasList()
  return { ok: true }
}

export async function deleteBoard(slug: string): Promise<OpResult> {
  // The open board stops saving before its file goes.
  for (const fn of opListeners) fn({ kind: 'deleted', slug })
  const r = await invoke('canvas.delete', { slug })
  await loadCanvasList()
  return r.ok ? { ok: true } : { ok: false, message: r.error.message }
}

export async function setPinned(slug: string, pinned: boolean): Promise<void> {
  // Shows at once; the list read after confirms it.
  canvasStore.setState((s) => ({
    entries: s.entries?.map((e) => (e.slug === slug ? { ...e, pinned } : e)) ?? null,
  }))
  await invoke('canvas.pin', { slug, pinned })
  await loadCanvasList()
}

let mounted = 0
let off: (() => void) | null = null

/**
 * Ref-counted: while any Canvas surface is mounted the list follows the folder ('canvas.changed'
 * from outside Relay) and reloads on focus and the reload action.
 */
export function mountCanvasList(): () => void {
  if (mounted++ === 0) {
    const offEvent = on('canvas.changed', () => void loadCanvasList())
    const offReload = registerReloader('canvas', loadCanvasList, [])
    off = () => {
      offEvent()
      offReload()
    }
  }
  void loadCanvasList()
  let done = false
  return () => {
    if (done) return
    done = true
    if (--mounted === 0) {
      off?.()
      off = null
    }
  }
}

export function useCanvasListSurface(): void {
  useEffect(() => mountCanvasList(), [])
}

export function resetCanvasForTests(): void {
  inflight = null
  queued = false
  off?.()
  off = null
  mounted = 0
  opListeners.clear()
  canvasStore.setState(initial(), true)
}
