import { useCallback, useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { invoke } from './ipc'

/**
 * The one home for small user-adjustable UI choices (filters, sort, view mode, folds, panel
 * widths). They live in `<configDir>/layout.json` under `ui`, beside the sidebar and pane layout,
 * so they survive a reload, a quit and a bundle swap (never the app bundle, never memory alone).
 * Main keeps each value verbatim; the reader of a key validates it with a `Parse`.
 */
export type Parse<T> = (raw: unknown) => T | null

const SAVE_DELAY_MS = 150

interface PrefState {
  values: Record<string, unknown>
  loaded: boolean
}

const prefStore = createStore<PrefState>(() => ({ values: {}, loaded: false }))
const unsaved = new Map<string, unknown>()
const hydrators = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

/** Called once layout.json is read: every bound store takes its saved choices. */
export function applyUiPrefs(raw: Record<string, unknown> | null): void {
  const values = { ...(raw ?? {}) }
  // A choice made before the file was read wins over the older saved one.
  for (const [k, v] of unsaved) values[k] = v
  prefStore.setState({ values, loaded: true })
  for (const h of hydrators) h()
  for (const fn of afterLoad.splice(0)) fn()
}

/** Writes every unsaved choice now (the quit path), instead of waiting out the debounce. */
export function flushUiPrefs(): void {
  clearTimeout(timer ?? undefined)
  timer = null
  if (unsaved.size === 0) return
  const ui = Object.fromEntries(unsaved)
  unsaved.clear()
  void invoke('layout.save', { ui })
    .then((r) => {
      if (!r.ok) console.warn('ui prefs save failed', r.error)
    })
    .catch(() => {})
}

const afterLoad: Array<() => void> = []

/** Runs `fn` once layout.json has been read: now when it already has. */
export function whenUiPrefsLoaded(fn: () => void): void {
  if (prefStore.getState().loaded) fn()
  else afterLoad.push(fn)
}

export function getPref<T>(key: string, fallback: T, parse: Parse<T>): T {
  const v = parse(prefStore.getState().values[key])
  return v === null ? fallback : v
}

export function setPref(key: string, value: unknown): void {
  prefStore.setState((s) => ({ values: { ...s.values, [key]: value } }))
  unsaved.set(key, value)
  if (timer === null) timer = setTimeout(flushUiPrefs, SAVE_DELAY_MS)
}

/** `[value, set]` for one saved choice; `fallback` stands until a valid saved value exists. */
export function usePref<T>(
  key: string,
  fallback: T,
  parse: Parse<T>,
): [T, (next: T | ((prev: T) => T)) => void] {
  const raw = useStore(prefStore, (s) => s.values[key])
  // fallback and parse are module constants at every call site; raw is what changes.
  const value = useMemo(() => parse(raw) ?? fallback, [raw])
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = getPref(key, fallback, parse)
      setPref(key, typeof next === 'function' ? (next as (p: T) => T)(prev) : next)
    },
    [key],
  )
  return [value, set]
}

/** How one slice of a zustand store is kept: `T` is the in-store shape, `Saved` the JSON shape. */
export interface PrefBinding<S, T, Saved = T> {
  select: (s: S) => T
  apply: (v: T) => Partial<S>
  /** Validates the saved JSON into `T`; null leaves the slice as it is. */
  parse: Parse<T>
  /** Equality of two selected values; a changed slice is saved. Default: same reference. */
  same?: (a: T, b: T) => boolean
  /** The JSON written for a value. Default: the value itself. */
  encode?: (v: T) => Saved
}

/**
 * Keeps one slice of a zustand store saved: the slice takes its saved value when layout.json
 * loads (or now, when it already has) and every later change to it is written back.
 */
export function bindPref<S, T, Saved = T>(
  store: StoreApi<S>,
  key: string,
  { select, apply, parse, same = Object.is, encode }: PrefBinding<S, T, Saved>,
): void {
  let hydrating = false
  const hydrate = (): void => {
    const v = parse(prefStore.getState().values[key])
    if (v === null) return
    hydrating = true
    try {
      store.setState(apply(v))
    } finally {
      hydrating = false
    }
  }
  store.subscribe((s, prev) => {
    if (hydrating || !prefStore.getState().loaded) return
    const next = select(s)
    if (!same(next, select(prev))) setPref(key, encode ? encode(next) : next)
  })
  hydrators.add(hydrate)
  if (prefStore.getState().loaded) hydrate()
}

/** A set of strings saved as a list. */
export const stringSet = {
  parse: ((v) => {
    const l = parseStringList(v)
    return l === null ? null : new Set(l)
  }) as Parse<Set<string>>,
  encode: (v: Set<string>): string[] => [...v],
}

export const parseBool: Parse<boolean> = (v) => (typeof v === 'boolean' ? v : null)

export const parseString: Parse<string> = (v) => (typeof v === 'string' ? v : null)

export function parseOneOf<T extends string | number>(allowed: readonly T[]): Parse<T> {
  return (v) => (allowed.includes(v as T) ? (v as T) : null)
}

export function parseNumber(min: number, max: number): Parse<number> {
  return (v) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : null
}

export const parseStringList: Parse<string[]> = (v) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null

/** An object of booleans; anything else is dropped. */
export const parseFlags: Parse<Record<string, boolean>> = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out: Record<string, boolean> = {}
  for (const [k, b] of Object.entries(v)) if (typeof b === 'boolean') out[k] = b
  return out
}

/** Test seam. */
export function resetUiPrefsForTests(): void {
  clearTimeout(timer ?? undefined)
  timer = null
  unsaved.clear()
  afterLoad.length = 0
  prefStore.setState({ values: {}, loaded: false }, true)
}
