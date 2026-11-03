import motionCss from '../styles/motion.css?raw'
import { StrictMode, createElement } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initMotion, resetEntranceForTests, resolveMotionOff, useEntrance } from './motion'

type L = () => void
let reduced = false
const ls = new Set<L>()
beforeEach(() => {
  reduced = false
  ls.clear()
  window.matchMedia = ((q: string) => ({
    get matches() {
      return q.includes('reduced') ? reduced : false
    },
    media: q,
    addEventListener: (_: string, l: L) => ls.add(l),
    removeEventListener: (_: string, l: L) => ls.delete(l),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia
  resetEntranceForTests()
})
afterEach(() => resetEntranceForTests())

describe('resolveMotionOff', () => {
  it('is true when any input is true', () => {
    expect(resolveMotionOff({ e2e: false, noMotion: false, reducedMotion: false })).toBe(false)
    expect(resolveMotionOff({ e2e: true, noMotion: false, reducedMotion: false })).toBe(true)
    expect(resolveMotionOff({ e2e: false, noMotion: true, reducedMotion: false })).toBe(true)
    expect(resolveMotionOff({ e2e: false, noMotion: false, reducedMotion: true })).toBe(true)
  })
  it('initMotion sets the attribute and flips live', () => {
    initMotion({ e2e: false, noMotion: false })
    expect(document.documentElement.dataset['evaMotion']).toBe('on')
    reduced = true
    ls.forEach((l) => l())
    expect(document.documentElement.dataset['evaMotion']).toBe('off')
    initMotion({ e2e: true, noMotion: false })
    expect(document.documentElement.dataset['evaMotion']).toBe('off')
  })
})

describe('useEntrance', () => {
  it('plays for the first mount only, StrictMode safe', () => {
    initMotion({ e2e: false, noMotion: false })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(StrictMode, null, children)
    const first = renderHook(() => useEntrance(), { wrapper })
    expect(first.result.current).toBe(true)
    expect(document.documentElement.dataset['evaPlayed']).toBe('true')
    const second = renderHook(() => useEntrance(), { wrapper })
    expect(second.result.current).toBe(false)
  })
  it('never plays with motion off', () => {
    initMotion({ e2e: true, noMotion: false })
    expect(renderHook(() => useEntrance()).result.current).toBe(false)
  })
})

describe('motion.css', () => {
  const css = motionCss
  const cues: [string, string, string, string?][] = [
    ['sidebar', '0s', '0.15s'],
    ['hero', '0.05s', '0.2s'],
    ['sections', '0.15s', '0.175s'],
    ['first-card', '0.5s', '0.15s'],
    ['first-chart', '0.55s', '0.35s'],
    ['second-card', '0.925s', '0.15s'],
    ['second-chart', '0.975s', '0.225s'],
    ['grid-cards', '1.225s', '0.2s', '0.075s'],
    ['aside-title', '1.5s', '0.15s'],
    ['aside-rows', '1.55s', '0.15s', '0.05s'],
    ['stats-title', '1.6s', '0.15s'],
    ['stat-cards', '1.75s', '0.15s', '0.04s'],
  ]
  it.each(cues)('declares cue %s', (name, delay, dur, step) => {
    expect(css).toContain(`--eva-cue-${name}-delay: ${delay};`)
    expect(css).toContain(`--eva-cue-${name}-duration: ${dur};`)
    if (step) expect(css).toContain(`--eva-cue-${name}-step: ${step};`)
    expect(css).toContain(`.eva-cue-${name} {`)
  })
  it('has an off block zeroing the variables', () => {
    const off = css.slice(css.indexOf("html[data-eva-motion='off'] {"))
    expect(off).toContain('--eva-cue-sidebar-delay: 0s;')
    expect(off).toContain('--eva-cue-stat-cards-step: 0s;')
    expect(off).toContain('--eva-dur-slide: 0s;')
    expect(off).toContain('animation: none;')
  })
})
