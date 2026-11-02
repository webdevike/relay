import { describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(() => Promise.resolve({ ok: true, value: {} })) }))

import { cssVariablesFor } from '@relay/widget-runtime/theme'
import { THEME_PRESETS, parseSavedTheme } from './theme-config'

const defaults = THEME_PRESETS[0]!.config

describe('parseSavedTheme', () => {
  it('merges a saved config over the Default preset, so keys added later still resolve', () => {
    const saved = parseSavedTheme({ config: { primaryColor: 'teal' }, preset: 'ocean' })
    expect(saved).toEqual({
      config: { ...defaults, primaryColor: 'teal' },
      preset: 'ocean',
      themes: [],
      colorScheme: 'light',
    })
  })

  it("reads saved themes and maps an older build's 'custom' to the theme it started from", () => {
    const saved = parseSavedTheme({
      config: { primaryColor: 'teal' },
      preset: 'user-calm',
      themes: [
        { value: 'user-calm', label: 'Calm', config: { primaryColor: 'teal' } },
        { value: 'forest', label: 'Forest', config: { focusRing: 'always' } },
        { value: 'bad' },
      ],
    })!
    expect(saved.preset).toBe('user-calm')
    expect(saved.themes.map((t) => t.value)).toEqual(['user-calm', 'forest'])
    expect(saved.themes[1]!.config).toEqual({ ...defaults, focusRing: 'always' })
    expect(parseSavedTheme({ config: {}, preset: 'custom' })!.preset).toBe('default')
  })

  it('defaults the focus ring to off in every built-in preset', () => {
    expect(THEME_PRESETS.length).toBeGreaterThan(1)
    for (const p of THEME_PRESETS) expect(p.config.focusRing).toBe('never')
    expect(defaults.focusRing).toBe('never')
  })

  it("reads an unmigrated saved 'auto' as off, in the config and in saved themes, but keeps 'always'", () => {
    const saved = parseSavedTheme({
      config: { focusRing: 'auto' },
      preset: 'forest',
      themes: [
        { value: 'forest', label: 'Forest', config: { focusRing: 'auto' } },
        { value: 'user-a', label: 'A', config: { focusRing: 'always' } },
      ],
    })!
    expect(saved.config.focusRing).toBe('never')
    expect(saved.themes.map((t) => t.config.focusRing)).toEqual(['never', 'always'])
    expect(parseSavedTheme({ config: {}, preset: 'default' })!.config.focusRing).toBe('never')
  })

  it("keeps an explicit 'auto' once the file is marked migrated", () => {
    const saved = parseSavedTheme({
      config: { focusRing: 'auto' },
      preset: 'default',
      focusRingMigrated: true,
    })!
    expect(saved.config.focusRing).toBe('auto')
  })

  it('reads the scheme beside the config, and moves an older in-config scheme out', () => {
    expect(parseSavedTheme({ config: {}, preset: 'forest', colorScheme: 'dark' })).toMatchObject({
      preset: 'forest',
      colorScheme: 'dark',
    })
    const old = parseSavedTheme({ config: { colorScheme: 'dark' }, preset: 'custom' })!
    expect(old.colorScheme).toBe('dark')
    expect('colorScheme' in old.config).toBe(false)
  })

  it('ignores anything that is not a config with a preset name', () => {
    for (const value of [null, undefined, 'x', {}, { config: {} }, { config: null, preset: 'a' }])
      expect(parseSavedTheme(value)).toBeUndefined()
  })
})

describe('cssVariablesFor', () => {
  it('writes each scheme its own semantic colors and shares chart colors', () => {
    const forest = THEME_PRESETS.find((p) => p.value === 'forest')!.config
    const vars = cssVariablesFor(forest)
    expect(vars.light['--mantine-color-body']).toBe('#fbfdfb')
    expect(vars.dark['--mantine-color-body']).toBe('#17201a')
    expect(vars.dark['--eva-color-surface']).toBe('#1d2921')
    expect(vars.variables['--eva-chart-1']).toBe(forest.chartColors[0])
  })
})
