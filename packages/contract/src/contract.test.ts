import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS, INVOKE_CHANNELS, invokeContract } from './index'

describe('contract', () => {
  it('lists app.info as an invoke channel', () => {
    expect(INVOKE_CHANNELS).toContain('app.info')
    expect(Array.isArray(EVENT_CHANNELS)).toBe(true)
  })

  it('rejects app.info output missing evaRoot', () => {
    const bad = { configDir: '/x', ompBin: 'omp', sessionsDir: '/s', live: false, e2e: true, launchCount: 1, version: '1' }
    expect(invokeContract['app.info'].output.safeParse(bad).success).toBe(false)
  })

  it('rejects unknown input keys on app.info', () => {
    expect(invokeContract['app.info'].input.safeParse({ extra: 1 }).success).toBe(false)
    expect(invokeContract['app.info'].input.safeParse({}).success).toBe(true)
  })
})
