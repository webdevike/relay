import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlotSync } from './useSlotSync'

let roCallback: () => void = () => {}
let frames: Array<() => void> = []

beforeEach(() => {
  frames = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCallback = cb
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('createSlotSync', () => {
  it('coalesces many observer callbacks in one frame into one rounded send', () => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({ x: 10.4, y: 20.6, width: 300.5, height: 400.2 }) as DOMRect
    const send = vi.fn()
    createSlotSync(el, send)
    for (let i = 0; i < 5; i++) roCallback()
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ x: 10, y: 21, width: 301, height: 400 })
    roCallback()
    frames.shift()!()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
