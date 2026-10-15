import { describe, expect, it } from 'vitest'
import {
  COLOR_KEYS,
  colorVars,
  defaultDoc,
  parseThemeDoc,
  resolveMode,
  resolveTheme,
  varName,
} from './index'

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i

describe('keys', () => {
  it('has 139 unique keys without the unused group_box title key', () => {
    expect(COLOR_KEYS).toHaveLength(139)
    expect(new Set(COLOR_KEYS).size).toBe(139)
    expect((COLOR_KEYS as readonly string[]).includes('group_box.title.foreground')).toBe(false)
  })
})

describe('resolveTheme', () => {
  it('resolves 139 valid dark colors from the bundled theme', () => {
    const dark = resolveTheme(defaultDoc(), 'dark')
    expect(Object.keys(dark.colors)).toHaveLength(139)
    for (const v of Object.values(dark.colors)) expect(v).toMatch(HEX)
  })

  it('switches base palettes without losing explicit overrides', () => {
    const doc = parseThemeDoc({ base: 'Flexoki', shared: { ring: '#abcdef' } })
    const flexoki = resolveTheme(doc, 'dark')
    doc.base = 'EvaOS'
    const evaos = resolveTheme(doc, 'dark')
    expect(flexoki.colors.background).not.toBe(evaos.colors.background)
    expect(flexoki.colors.ring).toBe('#abcdef')
    expect(evaos.colors.ring).toBe('#abcdef')
  })

  it('applies a light edit to light only', () => {
    const doc = defaultDoc()
    doc.light.edits['accent.background'] = '#123456'
    const light = resolveTheme(doc, 'light')
    const dark = resolveTheme(doc, 'dark')
    const baseLight = resolveTheme(defaultDoc(), 'light')
    expect(light.colors['accent.background']).toBe('#123456')
    expect(dark.colors).toEqual(resolveTheme(defaultDoc(), 'dark').colors)
    const changed = COLOR_KEYS.filter((k) => light.colors[k] !== baseLight.colors[k])
    expect(changed).toEqual(['accent.background'])
  })

  it('applies shared edits to both modes and lets mode edits win', () => {
    const doc = defaultDoc()
    doc.shared['ring'] = '#111111'
    doc.dark.edits['ring'] = '#222222'
    expect(resolveTheme(doc, 'light').colors.ring).toBe('#111111')
    expect(resolveTheme(doc, 'dark').colors.ring).toBe('#222222')
  })
})

describe('vars', () => {
  const light = resolveTheme(defaultDoc(), 'light')
  const dark = resolveTheme(defaultDoc(), 'dark')

  it('maps variable names', () => {
    expect(varName('tab_bar.segmented.background')).toBe('--eva-c-tab_bar-segmented-background')
    expect(varName('accent.background')).toBe('--eva-c-accent-background')
  })

  it('yields 139 vars with identical names across modes and differing values', () => {
    const l = colorVars(light)
    const d = colorVars(dark)
    expect(Object.keys(d)).toHaveLength(139)
    expect(Object.keys(d).every((k) => k.startsWith('--eva-c-'))).toBe(true)
    expect(Object.keys(d)).toEqual(Object.keys(l))
    expect(Object.keys(d).filter((k) => d[k] !== l[k]).length).toBeGreaterThanOrEqual(30)
  })
})

describe('parseThemeDoc', () => {
  it('falls back to the default doc on garbage', () => {
    for (const g of [null, 5, 'x', [], undefined]) {
      expect(parseThemeDoc(g).app.appearance).toBe('system')
    }
  })

  it('keeps appearance and unknown keys under raw', () => {
    const doc = parseThemeDoc({ app: { appearance: 'dark', extra: 1 } })
    expect(doc.app.appearance).toBe('dark')
    expect((doc.raw.app as { extra: number }).extra).toBe(1)
  })

  it('drops non-hex and unknown-key edits', () => {
    const doc = parseThemeDoc({
      shared: { ring: 'url(http://x)', 'nope.key': '#ffffff', border: '#abcdef' },
      app: { appearance: 'purple' },
    })
    expect(doc.shared).toEqual({ border: '#abcdef' })
    expect(doc.app.appearance).toBe('system')
  })

  it('resolves system appearance', () => {
    expect(resolveMode('system', true)).toBe('dark')
    expect(resolveMode('light', true)).toBe('light')
  })
})
