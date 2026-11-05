import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(async () => ({ ok: true, value: { ok: true } })) }))

import { invoke } from '../ipc'
import { startToastHoles, toastHoles } from './toast-holes'

function toast(rect: { left: number; top: number; right: number; bottom: number }): HTMLElement {
  const host = document.querySelector('.eva-toasts') ?? document.body.appendChild(div('eva-toasts'))
  const el = host.appendChild(div('mantine-Notifications-notification'))
  el.getBoundingClientRect = () =>
    ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }) as DOMRect
  return el
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

describe('toast holes', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    vi.mocked(invoke).mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('reads each toast rect, padded by its shadow and clamped to the window', () => {
    toast({ left: 900, top: 4, right: 1240, bottom: 100 })
    expect(toastHoles()).toEqual([{ x: 892, y: 0, width: 356, height: 108 }])
  })

  it('ignores toasts that are not laid out and elements outside the toast host', () => {
    toast({ left: 0, top: 0, right: 0, bottom: 0 })
    const stray = document.body.appendChild(div('mantine-Notifications-notification'))
    stray.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 50, bottom: 50, width: 50, height: 50 }) as DOMRect
    expect(toastHoles()).toEqual([])
  })

  it('sends the rects to main once per change and clears them when the last toast goes', async () => {
    const raf: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => raf.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const flush = (): void => raf.splice(0).forEach((cb) => cb(0))

    const stop = startToastHoles()
    flush()
    expect(invoke).toHaveBeenCalledTimes(1) // first read: none
    const el = toast({ left: 900, top: 4, right: 1240, bottom: 100 })
    await Promise.resolve() // the MutationObserver callback is a microtask
    flush()
    expect(invoke).toHaveBeenLastCalledWith('browser.setHoles', {
      holes: [{ x: 892, y: 0, width: 356, height: 108 }],
    })
    flush()
    expect(invoke).toHaveBeenCalledTimes(2) // unchanged: nothing sent
    el.remove()
    flush()
    expect(invoke).toHaveBeenLastCalledWith('browser.setHoles', { holes: [] })
    stop()
    vi.unstubAllGlobals()
  })
})
