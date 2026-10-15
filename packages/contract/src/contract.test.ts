import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS, INVOKE_CHANNELS, invokeContract } from './index'

describe('contract', () => {
  it('lists app.info as an invoke channel', () => {
    expect(INVOKE_CHANNELS).toContain('app.info')
    expect(Array.isArray(EVENT_CHANNELS)).toBe(true)
  })

  it('rejects app.info output missing evaRoot', () => {
    const bad = {
      configDir: '/x',
      ompBin: 'omp',
      sessionsDir: '/s',
      live: false,
      e2e: true,
      launchCount: 1,
      version: '1',
    }
    expect(invokeContract['app.info'].output.safeParse(bad).success).toBe(false)
  })

  it('rejects unknown input keys on app.info', () => {
    expect(invokeContract['app.info'].input.safeParse({ extra: 1 }).success).toBe(false)
    expect(invokeContract['app.info'].input.safeParse({}).success).toBe(true)
  })

  it('chat.snapshot output carries connected and error, not just running', () => {
    const base = {
      seq: 0,
      messages: [],
      meta: { model: null, thinking: null, contextTokens: null },
      running: false,
    }
    const out = invokeContract['chat.snapshot'].output
    expect(out.safeParse(base).success).toBe(false)
    expect(out.safeParse({ ...base, connected: false, error: 'ended' }).success).toBe(true)
    expect(out.safeParse({ ...base, connected: true, error: null }).success).toBe(true)
  })
})
