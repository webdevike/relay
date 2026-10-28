import { describe, expect, it } from 'vitest'
import { GAP, MAIN_MIN, SIDEBAR_MAX, SIDEBAR_MIN, fitSidebar } from './fit'

describe('fitSidebar', () => {
  it('wide windows get the wanted width', () => {
    expect(fitSidebar(1440, 272, MAIN_MIN)).toBe(272)
  })

  it('clamps to the min and max', () => {
    expect(fitSidebar(1440, 100, MAIN_MIN)).toBe(SIDEBAR_MIN)
    expect(fitSidebar(3000, 900, MAIN_MIN)).toBe(SIDEBAR_MAX)
  })

  it('shrinks to the room the tiling leaves, then folds', () => {
    const content = MAIN_MIN + GAP + 240
    expect(fitSidebar(content + GAP + 250, 272, content)).toBe(250)
    expect(fitSidebar(content + GAP + SIDEBAR_MIN - 1, 272, content)).toBe(0)
  })

  it('hidden is 0', () => {
    expect(fitSidebar(1440, undefined, MAIN_MIN)).toBe(0)
  })
})
