import { describe, expect, it } from 'vitest'
import {
  COLOR_KEYS,
  BASE_DARK,
  BASE_LIGHT,
  THEME_CATALOG,
  getThemePreset,
  hasThemeFamily,
  colorVars,
  defaultDoc,
  parseThemeDoc,
  resolveMode,
  serializeThemeDoc,
  validateThemeDoc,
  shapeVars,
  exportTheme,
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

  it('offers only paired families and resolves their native colors in both modes', () => {
    expect(THEME_CATALOG.map(({ id }) => id)).toEqual([
      'EvaOS', 'Ayu', 'Bold Tech', 'Bubblegum', 'Catppuccin', 'Everforest', 'Flexoki',
      'Gruvbox', 'Hybrid', 'macOS Classic', 'Mellifluous', 'Molokai', 'Solarized',
    ])
    for (const { id } of THEME_CATALOG) {
      expect(hasThemeFamily(id)).toBe(true)
      for (const mode of ['light', 'dark'] as const) {
        const preset = getThemePreset(id, mode)!
        expect(preset).toBeDefined()
        const resolved = resolveTheme(parseThemeDoc({ base: id }), mode)
        const kit = mode === 'dark' ? BASE_DARK : BASE_LIGHT
        for (const key of COLOR_KEYS) {
          expect(resolved.colors[key]).toBe(preset.colors[key] ?? kit[key])
          expect(resolved.colors[key]).toMatch(HEX)
        }
      }
    }
    expect(hasThemeFamily('Adventure')).toBe(false)
    expect(hasThemeFamily('toString')).toBe(false)
    expect(getThemePreset('missing', 'dark')).toBeUndefined()
  })

  it('uses the last native variant per mode and kit fallback rather than EvaOS colors', () => {
    expect(getThemePreset('Catppuccin', 'light')?.colors.background).toBe('#E5E9EF')
    expect(getThemePreset('Catppuccin', 'dark')?.colors.background).toBe('#181825')
    const bubblegum = resolveTheme(parseThemeDoc({ base: 'Bubblegum' }), 'light')
    expect(bubblegum.colors['tab_bar.background']).toBe(BASE_LIGHT['tab_bar.background'])
    expect(bubblegum.radius).toBe(14)
    expect(bubblegum.radiusLg).toBe(20)
    expect(bubblegum.font).toEqual(resolveTheme(defaultDoc(), 'light').font)
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

  it('resolves native shared typography and shape in both modes', () => {
    const doc = parseThemeDoc({
      base: 'Bubblegum',
      shared: { 'font.family': 'Inter', 'font.size': 18, 'mono_font.family': 'Menlo', 'mono_font.size': 16, radius: 0, 'radius.lg': 22, shadow: false },
    })
    for (const mode of ['light', 'dark'] as const) {
      const theme = resolveTheme(doc, mode)
      expect(theme.font).toEqual({ family: 'Inter', size: 18 })
      expect(theme.monoFont).toEqual({ family: 'Menlo', size: 16 })
      expect(theme.radius).toBe(0)
      expect(theme.radiusLg).toBe(22)
      expect(theme.shadow).toBe(false)
      expect(shapeVars(theme)).toMatchObject({ '--eva-font-size': '18px', '--eva-font-code-size': '16px', '--eva-radius': '0px', '--eva-shadow': 'none' })
    }
  })

  it('loads native nested colors and per-mode syntax styles without crossing modes', () => {
    const doc = parseThemeDoc({
      dark: { edits: { colors: { ring: '#123456' }, highlight: { 'editor.background': '#123123', syntax: { keyword: { color: '#abcdef', font_style: 'italic', font_weight: 700 } } } } },
    })
    const dark = resolveTheme(doc, 'dark')
    expect(dark.colors.ring).toBe('#123456')
    expect(dark.highlight['editor.background']).toBe('#123123')
    expect(dark.highlight.syntax.keyword).toMatchObject({ color: '#abcdef', font_style: 'italic', font_weight: 700 })
    expect(resolveTheme(doc, 'light').highlight).toEqual(resolveTheme(defaultDoc(), 'light').highlight)
    expect(resolveTheme(parseThemeDoc({ base: 'Ayu' }), 'dark').highlight.syntax.keyword?.color).not.toBe(dark.highlight.syntax.keyword?.color)
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

  it('filters malformed shared and syntax values at the tolerant load boundary', () => {
    const doc = parseThemeDoc({
      shared: { 'font.family': 'x\"; color:red', 'font.size': 1000, radius: -1, shadow: 'false' },
      dark: { edits: { highlight: { 'editor.background': 'url(x)', syntax: { keyword: { color: 'red', font_style: 'url(x)', font_weight: Infinity } } } } },
    })
    expect(doc.shared).toEqual({})
    expect(doc.dark.edits.highlight?.syntax?.keyword).toEqual({})
    expect(resolveTheme(doc, 'dark').highlight.syntax.keyword?.color).toMatch(HEX)
  })
})

describe('whole document persistence', () => {
  it('strictly rejects malformed known fields instead of silently saving defaults', () => {
    const valid = serializeThemeDoc(defaultDoc())
    expect(validateThemeDoc(valid)).toEqual(parseThemeDoc(valid))
    for (const invalid of [
      null, {}, { ...valid, base: 'toString' }, { ...valid, shared: [] },
      { ...valid, shared: { 'font.size': NaN } },
      { ...valid, shared: { 'mono_font.size': 8 } },
      { ...valid, shared: { radius: 25 } },
      { ...valid, shared: { 'radius.lg': -1 } },
      { ...valid, shared: { shadow: 'true' } },
      { ...valid, shared: { 'font.family': 'bad\";x' } },
      { ...valid, light: { edits: { colors: { ring: 'red' } } } },
      { ...valid, dark: { edits: { highlight: { syntax: { keyword: { font_weight: 901 } } } } } },
      { ...valid, app: { appearance: 'neon' } },
    ]) expect(() => validateThemeDoc(invalid)).toThrow()
  })

  it('removes owned overrides on reset while retaining unknown nested fields', () => {
    const doc = parseThemeDoc({
      shared: { 'font.size': 18, futureShape: 3 },
      dark: { futureMode: true, edits: { ring: '#111111', colors: { background: '#222222', futureColor: 'native-value' }, highlight: { 'editor.background': '#333333', futureHighlight: true, syntax: { keyword: { color: '#444444', futureStyle: 5 } } } } },
      app: { appearance: 'dark', futureApp: 4 },
      futureRoot: { a: 1 },
    })
    doc.shared = {}
    doc.dark.edits = {}
    const serialized = serializeThemeDoc(doc, { futureRoot: { b: 2 }, futureWriter: true })
    expect(serialized).toMatchObject({
      shared: { futureShape: 3 },
      dark: { futureMode: true, edits: { colors: { futureColor: 'native-value' }, highlight: { futureHighlight: true, syntax: { keyword: { futureStyle: 5 } } } } },
      app: { appearance: 'dark', futureApp: 4 }, futureRoot: { a: 1, b: 2 }, futureWriter: true,
    })
    expect(parseThemeDoc(serialized).shared).toEqual({})
    expect(parseThemeDoc(serialized).dark.edits.ring).toBeUndefined()
    expect(parseThemeDoc(serialized).dark.edits.background).toBeUndefined()
    expect(parseThemeDoc(serialized).dark.edits.highlight?.syntax?.keyword?.color).toBeUndefined()
  })
})

describe('document safety', () => {
  it('accepts the native editor range endpoints and future JSON values', () => {
    for (const shared of [
      { 'font.size': 10, 'mono_font.size': 9, radius: 0, 'radius.lg': 0 },
      { 'font.size': 24, 'mono_font.size': 24, radius: 24, 'radius.lg': 32 },
    ]) {
      const doc = { ...serializeThemeDoc(defaultDoc()), shared, future: { enabled: true, list: [null, 1, 'x'] } }
      expect(validateThemeDoc(doc).shared).toEqual(shared)
    }
  })

  it('does not persist non-JSON unknown values or pollute prototypes while preserving unknown keys', () => {
    const valid = serializeThemeDoc(defaultDoc())
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const future of [undefined, Infinity, () => {}, new Date(), circular]) {
      expect(() => validateThemeDoc({ ...valid, future })).toThrow()
    }
    const doc = parseThemeDoc(JSON.parse(JSON.stringify(valid).slice(0, -1) + ',\"__proto__\":{\"polluted\":true}}'))
    const result = serializeThemeDoc(doc)
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('portable theme export', () => {
  it('exports both fully flattened native palettes with typography, shape and syntax', () => {
    const doc = parseThemeDoc({
      base: 'Flexoki',
      shared: { 'font.family': 'Inter', 'font.size': 18, 'mono_font.family': 'Menlo', 'mono_font.size': 15, radius: 3, 'radius.lg': 19, shadow: true },
      light: { edits: { ring: '#112233' } },
      dark: { edits: { ring: '#abcdef', highlight: { syntax: { keyword: { color: '#123456', font_style: 'italic', font_weight: 700 } } } } },
      app: { appearance: 'dark' }, future: true,
    })
    const exported = exportTheme(doc)
    expect(exported).toMatchObject({ name: 'EvaOS', author: 'Isaac Weber', $schema: expect.stringContaining('gpui-kit') })
    expect(exported.themes).toHaveLength(2)
    for (const [index, mode] of (['light', 'dark'] as const).entries()) {
      const theme = exported.themes[index]!
      const resolved = resolveTheme(doc, mode)
      expect(theme).toMatchObject({
        name: mode === 'light' ? 'EvaOS Light' : 'EvaOS Dark', mode,
        'font.family': 'Inter', 'font.size': 18, 'mono_font.family': 'Menlo', 'mono_font.size': 15,
        radius: 3, 'radius.lg': 19, shadow: true,
      })
      expect(theme.colors).toEqual(resolved.colors)
      expect(Object.keys(theme.colors)).toHaveLength(COLOR_KEYS.length)
      expect(theme.highlight).toEqual(resolved.highlight)
      expect(theme).not.toHaveProperty('edits')
    }
    expect(exported.themes[0]!.colors.ring).toBe('#112233')
    expect(exported.themes[1]!.colors.ring).toBe('#abcdef')
    expect(exported.themes[1]!.highlight.syntax.keyword).toMatchObject({ color: '#123456', font_style: 'italic', font_weight: 700 })
    expect(exported).not.toHaveProperty('app')
    expect(exported).not.toHaveProperty('raw')
    expect(exported).not.toHaveProperty('shared')
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported)
  })
})
