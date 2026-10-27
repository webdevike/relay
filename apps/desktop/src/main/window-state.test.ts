import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

import { restorableWindow } from './window-state'

const MIN = { width: 760, height: 720 }
const main = { x: 0, y: 25, width: 3840, height: 1055 }
const left = { x: -1920, y: 0, width: 1920, height: 1080 }

describe('restorableWindow', () => {
  it('restores bounds and states that still fit a display', () => {
    const saved = {
      bounds: { x: 100.4, y: 60, width: 1600, height: 900 },
      maximized: true,
      fullScreen: false,
    }
    expect(restorableWindow(saved, [main], MIN)).toEqual({
      bounds: { x: 100, y: 60, width: 1600, height: 900 },
      maximized: true,
      fullScreen: false,
    })
  })

  it('a spot on a display that is gone, or barely on screen, falls back to the default', () => {
    const onLeft = { bounds: { x: -1800, y: 100, width: 1200, height: 800 } }
    expect(restorableWindow(onLeft, [main, left], MIN)).not.toBeNull()
    expect(restorableWindow(onLeft, [main], MIN)).toBeNull()
    const sliver = { bounds: { x: 3790, y: 100, width: 1200, height: 800 } }
    expect(restorableWindow(sliver, [main], MIN)).toBeNull()
  })

  it('missing, malformed or undersized state restores nothing', () => {
    for (const raw of [null, 'x', {}, { bounds: { x: 0, y: 0, width: 'w', height: 800 } }]) {
      expect(restorableWindow(raw, [main], MIN)).toBeNull()
    }
    const tiny = { bounds: { x: 0, y: 30, width: 400, height: 800 } }
    expect(restorableWindow(tiny, [main], MIN)).toBeNull()
  })
})
