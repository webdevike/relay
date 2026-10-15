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

  it('includes the Phase 2 channels', () => {
    for (const c of [
      'layout.load',
      'layout.save',
      'theme.load',
      'theme.setAppearance',
      'settings.load',
      'settings.save',
      'eva.sidebar',
      'app.setBackground',
      'app.quit',
      'app.unsavedEdits.reply',
      'app.saveDirty.reply',
    ])
      expect(INVOKE_CHANNELS).toContain(c)
    for (const c of ['app.hotkey', 'app.unsavedEdits.request', 'app.saveDirty.request'])
      expect(EVENT_CHANNELS).toContain(c)
  })

  it('validates app.setBackground colors', () => {
    const i = invokeContract['app.setBackground'].input
    expect(i.safeParse({ color: 'red' }).success).toBe(false)
    expect(i.safeParse({ color: '#fff' }).success).toBe(false)
    expect(i.safeParse({ color: '#181817' }).success).toBe(true)
  })

  it('layout.save is strict and bounded', () => {
    const i = invokeContract['layout.save'].input
    const place = { page: 'home' }
    const tab = (n: number) => ({
      here: place,
      back: Array.from({ length: n }, () => place),
      forward: [],
      pinned: false,
    })
    expect(i.safeParse({ extra: 1 }).success).toBe(false)
    expect(i.safeParse({ tabs: { active: 0, list: [tab(51)] } }).success).toBe(false)
    expect(i.safeParse({ tabs: { active: 0, list: [tab(50)] } }).success).toBe(true)
  })

  it('settings.save accepts partials', () => {
    expect(invokeContract['settings.save'].input.safeParse({ show_thinking: false }).success).toBe(
      true,
    )
  })

  it('app.info output defaults noMotion to false', () => {
    const out = invokeContract['app.info'].output.parse({
      evaRoot: '/e',
      configDir: '/c',
      ompBin: 'omp',
      sessionsDir: '/s',
      live: false,
      e2e: true,
      launchCount: 1,
      version: '1',
    })
    expect(out.noMotion).toBe(false)
  })
})
