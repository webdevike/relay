import { renderHook, render } from '@testing-library/react'
import { TERMINAL_PASS_THROUGH, GLOBAL_CHORDS } from '@evaos/shell-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => ({ ok: true, value: {} }))
let hotkeyCb: ((p: { chord: string; fromGuest: boolean }) => void) | null = null
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
  on: (_c: string, cb: typeof hotkeyCb) => {
    hotkeyCb = cb
    return () => {
      hotkeyCb = null
    }
  },
}))

import { browserStore } from '../browser/browser-store'
import { useBrowserHotkeys } from '../browser/useBrowserHotkeys'
import { useDismissable } from './dismiss'
import { setFocusedPane } from './pane-focus'
import { activateTab, openTab, resetTilingForTests, tilingStore } from '../tiling/tiling-store'
import { mountTestDock } from '../tiling/test-dock'
import { resetTabsForTests, tabsStore } from '../tabs/tabs-store'
import {
  registerAction,
  registerOverlayChord,
  registerPageChord,
  registerTerminalScope,
  setChordLock,
  dispatchChord,
  startHotkeyRouter,
} from './router'

function key(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(e)
  return e
}

let stop: () => void
beforeEach(() => {
  invoke.mockClear()
  window.__evaosHotkeys = undefined
  stop = startHotkeyRouter()
})
afterEach(() => {
  stop()
  setFocusedPane(null)
  resetTilingForTests()
})

describe('chord lock', () => {
  afterEach(() => setChordLock(null))
  it('consumes every chord but cmd+q, including guest chords, until cleared', () => {
    const fn = vi.fn()
    const offs = [registerAction('new-tab', fn), registerAction('new-todo', fn)]
    setChordLock((c) => c === 'cmd+q')
    for (const [k, code] of [
      ['t', 'KeyT'],
      ['n', 'KeyN'],
      ['r', 'KeyR'],
      ['w', 'KeyW'],
    ] as const)
      expect(key({ key: k, code, metaKey: true }).defaultPrevented).toBe(true)
    expect(key({ key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(true)
    expect(dispatchChord('cmd+t', { fromGuest: true })).toBe(true)
    expect(fn).not.toHaveBeenCalled()
    expect(key({ key: 'q', code: 'KeyQ', metaKey: true }).defaultPrevented).toBe(false)
    setChordLock(null)
    key({ key: 't', code: 'KeyT', metaKey: true })
    expect(fn).toHaveBeenCalled()
    offs.forEach((o) => o())
  })
})

describe('hotkey router', () => {
  it('ignores auto-repeated keydown events', () => {
    const fn = vi.fn()
    const off = registerAction('toggle-panel', fn)
    key({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true, repeat: true })
    expect(fn).not.toHaveBeenCalled()
    key({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true })
    expect(fn).toHaveBeenCalledTimes(1)
    off()
  })
  it('dispatches a global chord and ignores plain typing and native edit chords', () => {
    const fn = vi.fn()
    const off = registerAction('toggle-panel', fn)
    const e = key({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(key({ key: 'b', code: 'KeyB' }).defaultPrevented).toBe(false)
    expect(key({ key: 'c', code: 'KeyC', metaKey: true }).defaultPrevented).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
  })

  it('overlay scope outranks global', () => {
    const g = vi.fn()
    const offA = registerAction('toggle-sidebar', g)
    const offO = registerOverlayChord('cmd+b', () => 'consumed')
    key({ key: 'b', code: 'KeyB', metaKey: true })
    expect(g).not.toHaveBeenCalled()
    offO()
    offA()
  })

  it('terminal scope yields non pass-through chords', () => {
    const reload = vi.fn()
    const panel = vi.fn()
    const o1 = registerAction('reload', reload)
    const o2 = registerAction('toggle-panel', panel)
    const offT = registerTerminalScope(TERMINAL_PASS_THROUGH)
    const r = key({ key: 'r', code: 'KeyR', metaKey: true })
    expect(r.defaultPrevented).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    key({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true })
    expect(panel).toHaveBeenCalledTimes(1)
    offT()
    o1()
    o2()
  })

  it('escape is swallowed only when something is dismissed', () => {
    expect(key({ key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(false)
    const hi = vi.fn()
    const lo = vi.fn()
    function Hi() {
      useDismissable(100, hi)
      return null
    }
    function Lo() {
      useDismissable(10, lo)
      return null
    }
    const a = render(<Hi />)
    render(<Lo />)
    expect(key({ key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(true)
    expect(hi).toHaveBeenCalledTimes(1)
    expect(lo).not.toHaveBeenCalled()
    a.unmount()
    key({ key: 'Escape', code: 'Escape' })
    expect(lo).toHaveBeenCalledTimes(1)
  })

  it('logs every global chord under e2e, capped at 200, even without handlers', () => {
    window.__evaosHotkeys = []
    for (const { chord } of GLOBAL_CHORDS) {
      if (chord === 'escape') continue
      const m = /^cmd\+(alt\+)?(shift\+)?(.+)$/.exec(chord)!
      const k = m[3]!
      const arrow = /^arrow(left|right|up|down)$/.exec(k)
      const key_ = arrow
        ? `Arrow${arrow[1]![0]!.toUpperCase()}${arrow[1]!.slice(1)}`
        : k === 'enter'
          ? 'Enter'
          : k
      const code = arrow
        ? key_
        : k === 'enter'
          ? 'Enter'
          : /^\d$/.test(k)
            ? `Digit${k}`
            : /^[a-z]$/.test(k)
              ? `Key${k.toUpperCase()}`
              : (
                  { '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash' } as Record<
                    string,
                    string
                  >
                )[k]!
      key({ key: key_, code, metaKey: true, altKey: !!m[1], shiftKey: !!m[2] })
    }
    const logged = window.__evaosHotkeys.map((x) => x.chord)
    for (const { chord } of GLOBAL_CHORDS) if (chord !== 'escape') expect(logged).toContain(chord)
    for (let i = 0; i < 250; i++) key({ key: 'n', code: 'KeyN', metaKey: true })
    expect(window.__evaosHotkeys.length).toBe(200)
    expect(window.__evaosHotkeys[0]).toMatchObject({
      action: expect.any(String),
      at: expect.any(Number),
    })
  })

  it('cmd+left and cmd+right go Back and Forward, but leave the caret alone in a text field', () => {
    const back = vi.fn()
    const fwd = vi.fn()
    const offs = [registerAction('history-back', back), registerAction('history-forward', fwd)]
    const arrow = (k: 'ArrowLeft' | 'ArrowRight') => key({ key: k, code: k, metaKey: true })
    expect(arrow('ArrowLeft').defaultPrevented).toBe(true)
    expect(arrow('ArrowRight').defaultPrevented).toBe(true)
    expect(back).toHaveBeenCalledTimes(1)
    expect(fwd).toHaveBeenCalledTimes(1)
    for (const tag of ['textarea', 'input'] as const) {
      const field = document.body.appendChild(document.createElement(tag))
      field.focus()
      expect(arrow('ArrowLeft').defaultPrevented).toBe(false)
      expect(arrow('ArrowRight').defaultPrevented).toBe(false)
      field.remove()
    }
    expect(back).toHaveBeenCalledTimes(1)
    expect(fwd).toHaveBeenCalledTimes(1)
    // Cmd+[ is not a caret chord: it still steps back from a text field.
    const field = document.body.appendChild(document.createElement('textarea'))
    field.focus()
    key({ key: '[', code: 'BracketLeft', metaKey: true })
    expect(back).toHaveBeenCalledTimes(2)
    field.remove()
    offs.forEach((o) => o())
  })

  it("cmd+w closes the page for guest keys and in a page tab's pane, else falls through", () => {
    browserStore.setState({ tabs: [{ id: 't1' }] as never, activeId: 't1' })
    const close = vi.fn()
    const off = registerAction('close-tab', close)
    const { unmount } = renderHook(() => useBrowserHotkeys())
    hotkeyCb!({ chord: 'cmd+w', fromGuest: true })
    expect(invoke).toHaveBeenCalledWith('browser.closeTab', { tabId: 't1' })
    expect(close).not.toHaveBeenCalled()
    invoke.mockClear()
    hotkeyCb!({ chord: 'cmd+w', fromGuest: false })
    expect(invoke).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    // The default tool pane has the keyboard, with Files in front: not a page tab.
    resetTabsForTests()
    tabsStore.setState({ loaded: true })
    const unmountDock = mountTestDock()
    const tools = tilingStore.getState().panes.find((p) => !p.app)!
    openTab({ kind: 'web', id: 't1' }, tools.id)
    setFocusedPane(tools.id)
    activateTab('files')
    invoke.mockClear()
    hotkeyCb!({ chord: 'cmd+w', fromGuest: false })
    expect(invoke).not.toHaveBeenCalled()
    // The page tab in front: it closes, and its page with it.
    activateTab('web:t1')
    hotkeyCb!({ chord: 'cmd+w', fromGuest: false })
    expect(invoke).toHaveBeenCalledWith('browser.closeTab', { tabId: 't1' })
    expect(tilingStore.getState().panes.some((p) => p.views.includes('web:t1'))).toBe(false)
    unmount()
    unmountDock()
    off()
  })

  it('ignores composing keydown events', () => {
    const fn = vi.fn()
    const off = registerAction('toggle-sidebar', fn)
    key({ key: 'b', code: 'KeyB', metaKey: true, isComposing: true })
    expect(fn).not.toHaveBeenCalled()
    off()
  })
})

describe('plain digit chords', () => {
  it('reach a page handler outside inputs, never inside them', () => {
    const fn = vi.fn(() => 'consumed' as const)
    const off = registerPageChord('2', fn)
    expect(key({ key: '2', code: 'Digit2' }).defaultPrevented).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    key({ key: '2', code: 'Digit2' })
    expect(fn).toHaveBeenCalledTimes(1)
    input.remove()
    key({ key: '5', code: 'Digit5' })
    expect(fn).toHaveBeenCalledTimes(1)
    off()
  })

  it('stay unhandled when no page handler claims them', () => {
    expect(key({ key: '1', code: 'Digit1' }).defaultPrevented).toBe(false)
  })
})
