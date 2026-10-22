import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_PASS_THROUGH } from './chord'
import { createScopes, terminalClaim } from './scopes'

describe('scopes', () => {
  it('runs global when nothing else claims', () => {
    const s = createScopes()
    const g = vi.fn(() => 'consumed' as const)
    s.register('global', 'cmd+b', g)
    expect(s.dispatch('cmd+b')).toEqual({ result: 'consumed', scope: 'global' })
    expect(s.dispatch('cmd+x')).toEqual({ result: 'unhandled' })
  })
  it('overlay consumes before global', () => {
    const s = createScopes()
    const g = vi.fn(() => 'consumed' as const)
    s.register('global', 'escape', g)
    s.register('overlay', 'escape', () => 'consumed')
    expect(s.dispatch('escape').scope).toBe('overlay')
    expect(g).not.toHaveBeenCalled()
  })
  it('terminal scope yields everything except the pass-through list', () => {
    const s = createScopes()
    const g = vi.fn(() => 'consumed' as const)
    for (const c of ['cmd+c', 'cmd+r', ...TERMINAL_PASS_THROUGH]) s.register('global', c, g)
    s.register('terminal', '*', terminalClaim(TERMINAL_PASS_THROUGH))
    for (const c of ['cmd+c', 'cmd+r']) {
      expect(s.dispatch(c)).toEqual({ result: 'yield', scope: 'terminal' })
    }
    expect(g).not.toHaveBeenCalled()
    for (const c of ['cmd+b', 'cmd+shift+b', 'cmd+t', 'cmd+w', 'cmd+q']) {
      expect(terminalClaim(TERMINAL_PASS_THROUGH)(c)).toBe(false)
      expect(s.dispatch(c).scope).toBe('global')
    }
  })
  it('unregister removes; newest runs first', () => {
    const s = createScopes()
    s.register('global', 'a', () => 'consumed')
    const off = s.register('global', 'a', () => 'yield')
    expect(s.dispatch('a').result).toBe('yield')
    off()
    expect(s.dispatch('a').result).toBe('consumed')
  })
})
