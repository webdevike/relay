import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'

const invoke = vi.hoisted(() =>
  vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, value: {} })),
)
vi.mock('./ipc', () => ({ invoke }))

import { applyUiPrefs, bindPref, flushUiPrefs, parseOneOf, setPref } from './ui-prefs'

beforeEach(() => invoke.mockClear())

describe('bindPref', () => {
  it('takes the saved value on load, ignores an invalid one, and saves later changes once', () => {
    const store = createStore(() => ({ sort: 'name', open: true }))
    bindPref(store, 'k.sort', {
      select: (s) => s.sort,
      apply: (sort) => ({ sort }),
      parse: parseOneOf(['name', 'uses']),
    })
    bindPref(store, 'k.open', {
      select: (s) => s.open,
      apply: (open) => ({ open }),
      parse: (v) => (typeof v === 'boolean' ? v : null),
    })
    store.setState({ sort: 'uses' })
    expect(invoke).not.toHaveBeenCalled()

    applyUiPrefs({ 'k.sort': 'uses', 'k.open': 'not a bool' })
    expect(store.getState()).toEqual({ sort: 'uses', open: true })
    expect(invoke).not.toHaveBeenCalled()

    store.setState({ sort: 'name' })
    store.setState({ open: false })
    flushUiPrefs()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('layout.save', {
      ui: { 'k.sort': 'name', 'k.open': false },
    })
  })

  it('a choice made before the file was read wins over the saved one', () => {
    const store = createStore(() => ({ n: 1 }))
    bindPref(store, 'k.n', {
      select: (s) => s.n,
      apply: (n) => ({ n }),
      parse: (v) => (typeof v === 'number' ? v : null),
    })
    setPref('k.n', 7)
    applyUiPrefs({ 'k.n': 3 })
    expect(store.getState().n).toBe(7)
  })
})
