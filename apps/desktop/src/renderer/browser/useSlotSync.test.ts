import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlots, type Slots } from './useSlotSync'

let roCallback: () => void = () => {}
let frames: Array<() => void> = []
let slots: Slots | null = null

beforeEach(() => {
  frames = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => {
  slots?.dispose()
  slots = null
  vi.unstubAllGlobals()
})

function el(x: number, y: number, width: number, height: number): HTMLElement {
  const e = document.createElement('div')
  e.getBoundingClientRect = () => ({ x, y, width, height }) as DOMRect
  return e
}

describe('createSlots', () => {
  it('sends every visible page in one call per frame, rounded, only when something changed', () => {
    const send = vi.fn()
    slots = createSlots(send)
    slots.add('t1', el(10.4, 20.6, 300.5, 400.2))
    slots.add('t2', el(320, 20, 280, 400))
    for (let i = 0; i < 5; i++) roCallback()
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith([
      { tabId: 't1', x: 10, y: 21, width: 301, height: 400 },
      { tabId: 't2', x: 320, y: 20, width: 280, height: 400 },
    ])
    roCallback()
    frames.shift()!()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('parks a page that leaves (and one with no room) by leaving it out', () => {
    const send = vi.fn()
    slots = createSlots(send)
    const off = slots.add('t1', el(0, 0, 300, 400))
    slots.add('t2', el(300, 0, 0, 400))
    frames.shift()!()
    expect(send).toHaveBeenLastCalledWith([{ tabId: 't1', x: 0, y: 0, width: 300, height: 400 }])
    off()
    frames.shift()!()
    expect(send).toHaveBeenLastCalledWith([])
  })
})
