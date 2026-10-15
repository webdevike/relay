// Generates src/base-light.ts and src/base-dark.ts: the kit base for all 139 color keys.
// Run manually: node packages/theme-core/scripts/gen-base.ts  (Node 24 type stripping)
//
// Reads (read-only): gpui-component 0.7.0 default-theme.json, default-colors.json, schema.rs
// under ~/.cargo. Writes only the two base files. Ports ThemeColor::apply_config fallbacks in
// schema.rs order (lines 682-1064) with the Hsla helpers of color.rs.
//
// Approximations: gpui's Hsla/Rgba conversions are reimplemented in float64 instead of f32, and
// emitted hex is rounded to the nearest 8-bit value (gpui to_hex truncates). Differences are at
// most one unit per channel.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLOR_KEYS } from '../src/keys.ts'

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const CARGO = path.join(
  os.homedir(),
  '.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/gpui-component-0.7.0/src/theme',
)
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

function parseHex(hex: string): Rgba {
  const h = hex.replace(/^#/, '')
  if (h.length !== 6 && h.length !== 8) throw new Error(`bad hex ${hex}`)
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 }
}

function toHex(c: Rgba): string {
  const b = (v: number): string =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${b(c.r)}${b(c.g)}${b(c.b)}${c.a < 1 ? b(c.a) : ''}`
}

const opacity = (c: Rgba, f: number): Rgba => ({ ...c, a: c.a * clamp01(f) })

/** gpui Rgba::blend: `top` composited over `base`; Hsla::blend short-circuits on alpha. */
function blend(base: Rgba, top: Rgba): Rgba {
  if (top.a >= 1) return top
  if (top.a <= 0) return base
  const a = top.a + base.a * (1 - top.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const ch = (t: number, s: number): number => (t * top.a + s * base.a * (1 - top.a)) / a
  return { r: ch(top.r, base.r), g: ch(top.g, base.g), b: ch(top.b, base.b), a }
}

function toHsl(c: Rgba): { h: number; s: number; l: number } {
  const max = Math.max(c.r, c.g, c.b)
  const min = Math.min(c.r, c.g, c.b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === c.r) h = ((((c.g - c.b) / d) % 6) + 6) % 6
  else if (max === c.g) h = (c.b - c.r) / d + 2
  else h = (c.r - c.g) / d + 4
  return { h: h / 6, s, l }
}

function fromHsl(h: number, s: number, l: number, a: number): Rgba {
  const k = (n: number): number => (n + h * 12) % 12
  const q = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - q * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return { r: f(0), g: f(8), b: f(4), a }
}

function scaleL(c: Rgba, factor: number): Rgba {
  const { h, s, l } = toHsl(c)
  return fromHsl(h, s, l * factor, c.a)
}
const lighten = (c: Rgba, f: number): Rgba => scaleL(c, 1 + clamp01(f))
const darken = (c: Rgba, f: number): Rgba => scaleL(c, 1 - clamp01(f))

const toLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLin = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

function toOklab(c: Rgba): [number, number, number] {
  const [lr, lg, lb] = [toLin(c.r), toLin(c.g), toLin(c.b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab(L: number, a: number, b: number, alpha: number): Rgba {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3]
  return {
    r: clamp01(fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    a: alpha,
  }
}

/** color.rs mix_oklab: premultiplied-alpha Oklab interpolation, `self` weighted by factor. */
function mixOklab(self: Rgba, other: Rgba, factor: number): Rgba {
  const f = clamp01(factor)
  const inv = 1 - f
  const alpha = self.a * f + other.a * inv
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const [l1, a1, b1] = toOklab(self)
  const [l2, a2, b2] = toOklab(other)
  const mix = (x: number, y: number): number => (x * self.a * f + y * other.a * inv) / alpha
  return fromOklab(mix(l1, l2), mix(a1, a2), mix(b1, b2), alpha)
}

// Palette
type Scale = { scale: number; hex: string }
const palette = JSON.parse(
  fs.readFileSync(path.join(CARGO, 'default-colors.json'), 'utf8'),
) as Record<string, unknown>

function paletteColor(name: string, scale: number): Rgba {
  const entry = palette[name]
  if (name === 'black' || name === 'white') return parseHex((entry as { hex: string }).hex)
  const list = entry as Scale[] | undefined
  const hit = list?.find((e) => e.scale === scale)
  if (!hit) throw new Error(`unknown palette color ${name}-${scale}`)
  return parseHex(hit.hex)
}

/** try_parse_color: `#hex`, `name`, `name-scale`, `name/opacity`, `name-scale/opacity`. */
function parseColor(value: string): Rgba {
  if (value.startsWith('#')) return parseHex(value)
  const m = /^([a-z]+)(?:-(\d+))?(?:\/(\d+(?:\.\d+)?))?$/.exec(value)
  if (!m) throw new Error(`cannot parse color ${value}`)
  const c = paletteColor(m[1], m[2] ? Number(m[2]) : 500)
  return m[3] ? opacity(c, Number(m[3]) / 100) : c
}

// key -> ThemeColor field, from the serde renames in schema.rs ThemeConfigColors
const schema = fs.readFileSync(path.join(CARGO, 'schema.rs'), 'utf8')
const cfgBlock = schema.slice(
  schema.indexOf('pub struct ThemeConfigColors'),
  schema.indexOf('impl ThemeColor'),
)
const keyToField = new Map<string, string>()
for (const m of cfgBlock.matchAll(/rename = "([^"]+)"\)\]\s*(?:pub )?(\w+):/g))
  keyToField.set(m[1], m[2])

type Cfg = { name: string; mode: string; colors: Record<string, string> }
const themeSet = JSON.parse(fs.readFileSync(path.join(CARGO, 'default-theme.json'), 'utf8')) as {
  themes: Cfg[]
}

function build(cfg: Cfg): Record<string, string> {
  const dark = cfg.mode === 'dark'
  const raw = new Map<string, string>()
  for (const [k, v] of Object.entries(cfg.colors)) {
    const f = keyToField.get(k)
    // The kit ignores unknown keys (default-theme.json has a "description_list_label.foreground"
    // typo), so skip them like serde does.
    if (!f) continue
    raw.set(f, v)
  }
  const out = new Map<string, Rgba>()
  const g = (f: string): Rgba => {
    const c = out.get(f)
    if (!c) throw new Error(`field ${f} read before set`)
    return c
  }
  const missing: string[] = []
  const set = (f: string, fallback?: () => Rgba): void => {
    const v = raw.get(f)
    if (v !== undefined) {
      out.set(f, parseColor(v))
    } else if (fallback) {
      out.set(f, fallback())
    } else {
      missing.push(f)
    }
  }
  const bg = (): Rgba => g('background')
  const transparent: Rgba = { r: 0, g: 0, b: 0, a: 0 }
  const activeDarken = dark ? 0.2 : 0.1
  const hover = 0.9

  set('background')
  for (const c of ['red', 'green', 'blue', 'magenta', 'yellow', 'cyan']) {
    set(c)
    set(`${c}_light`, () => blend(bg(), opacity(g(c), 0.8)))
  }
  set('border')
  set('foreground')
  set('input', () => g('border'))
  set('muted')
  set('muted_foreground', () => blend(g('muted'), opacity(g('foreground'), 0.7)))

  set('button', () => (dark ? mixOklab(g('input'), transparent, 0.3) : bg()))
  set('button_foreground', () => g('foreground'))
  set('button_hover', () => mixOklab(g('input'), transparent, 0.5))
  set('button_active', () => mixOklab(g('input'), transparent, 0.7))
  set('primary')
  set('primary_foreground', () => g('foreground'))
  set('primary_hover', () => blend(bg(), opacity(g('primary'), hover)))
  set('primary_active', () => darken(g('primary'), activeDarken))
  set('button_primary', () => g('primary'))
  set('button_primary_foreground', () => g('primary_foreground'))
  set('button_primary_hover', () => g('primary_hover'))
  set('button_primary_active', () => g('primary_active'))
  set('secondary')
  set('secondary_foreground', () => g('foreground'))
  set('secondary_hover', () => blend(bg(), opacity(g('secondary'), hover)))
  set('secondary_active', () => darken(g('secondary'), activeDarken))
  set('button_secondary', () => g('secondary'))
  set('button_secondary_foreground', () => g('secondary_foreground'))
  set('button_secondary_hover', () => g('secondary_hover'))
  set('button_secondary_active', () => g('secondary_active'))

  const status = (
    name: string,
    base: string,
    hoverFallback: () => Rgba,
    activeFallback: () => Rgba,
  ): void => {
    set(name, () => g(base))
    set(`${name}_foreground`, () => g('primary_foreground'))
    set(`${name}_hover`, hoverFallback)
    set(`${name}_active`, activeFallback)
    set(`button_${name}`, () => mixOklab(g(name), transparent, 0.2))
    set(`button_${name}_foreground`, () => g(name))
    set(`button_${name}_hover`, () => mixOklab(g(name), transparent, 0.3))
    set(`button_${name}_active`, () => mixOklab(g(name), transparent, 0.4))
  }
  status(
    'success',
    'green',
    () => blend(bg(), opacity(g('success'), hover)),
    () => darken(g('success'), activeDarken),
  )
  status(
    'info',
    'cyan',
    () => blend(bg(), opacity(g('info'), hover)),
    () => darken(g('info'), activeDarken),
  )
  status(
    'warning',
    'yellow',
    () => blend(bg(), opacity(g('warning'), 0.9)),
    () => blend(bg(), darken(g('warning'), activeDarken)),
  )

  set('accent', () => g('secondary'))
  set('accent_foreground', () => g('foreground'))
  set('accordion', () => bg())
  set('group_box', () => blend(bg(), opacity(g('secondary'), dark ? 0.3 : 0.4)))
  set('group_box_foreground', () => g('foreground'))
  set('caret', () => g('primary'))
  set('chart_1', () => lighten(g('blue'), 0.4))
  set('chart_2', () => lighten(g('blue'), 0.2))
  set('chart_3', () => g('blue'))
  set('chart_4', () => darken(g('blue'), 0.2))
  set('chart_5', () => darken(g('blue'), 0.4))
  set('chart_bullish', () => g('green'))
  set('chart_bearish', () => g('red'))
  set('chart_grid', () => opacity(g('border'), 0.6))
  set('danger', () => g('red'))
  set('danger_active', () => darken(g('danger'), activeDarken))
  set('danger_foreground', () => g('primary_foreground'))
  set('danger_hover', () => blend(bg(), opacity(g('danger'), 0.9)))
  set('button_danger', () => mixOklab(g('danger'), transparent, 0.2))
  set('button_danger_foreground', () => g('danger'))
  set('button_danger_hover', () => mixOklab(g('danger'), transparent, 0.3))
  set('button_danger_active', () => mixOklab(g('danger'), transparent, 0.4))
  set('description_list_label', () => blend(bg(), opacity(g('border'), 0.2)))
  set('description_list_label_foreground', () => g('muted_foreground'))
  set('drag_border', () => opacity(g('primary'), 0.65))
  set('drop_target', () => opacity(g('primary'), 0.2))
  set('link', () => g('primary'))
  set('link_active', () => g('link'))
  set('link_hover', () => g('link'))
  set('list', () => bg())
  set('list_active', () => blend(bg(), opacity(g('primary'), 0.1)))
  set('list_active_border', () => blend(bg(), opacity(g('primary'), 0.6)))
  set('list_even', () => g('list'))
  set('list_head', () => g('list'))
  set('list_hover', () => opacity(g('accent'), 0.6))
  set('popover', () => bg())
  set('popover_foreground', () => g('foreground'))
  set('progress_bar', () => g('primary'))
  set('ring', () => g('blue'))
  set('scrollbar', () => bg())
  set('scrollbar_thumb', () => g('accent'))
  set('scrollbar_thumb_hover', () => g('scrollbar_thumb'))
  set('selection', () => g('primary'))
  set('sidebar', () => blend(bg(), opacity(g('border'), 0.15)))
  set('sidebar_accent', () => g('accent'))
  set('sidebar_accent_foreground', () => g('accent_foreground'))
  set('sidebar_border', () => g('border'))
  set('sidebar_foreground', () => g('foreground'))
  set('sidebar_primary', () => g('primary'))
  set('sidebar_primary_foreground', () => g('primary_foreground'))
  set('skeleton', () => g('secondary'))
  set('slider_bar', () => g('primary'))
  set('slider_thumb', () => g('primary_foreground'))
  set('switch', () => g('secondary_active'))
  set('switch_thumb', () => bg())
  set('tab', () => bg())
  set('tab_active', () => bg())
  set('tab_active_foreground', () => g('foreground'))
  set('tab_bar', () => bg())
  set('tab_bar_segmented', () => g('secondary'))
  set('tab_foreground', () => g('foreground'))
  set('table', () => g('list'))
  set('table_active', () => g('list_active'))
  set('table_active_border', () => g('list_active_border'))
  set('table_even', () => g('list_even'))
  set('table_head', () => g('list_head'))
  set('table_head_foreground', () => g('muted_foreground'))
  set('table_foot', () => g('list_head'))
  set('table_foot_foreground', () => g('muted_foreground'))
  set('table_hover', () => g('list_hover'))
  set('table_row_border', () => g('border'))
  set('title_bar', () => bg())
  set('title_bar_border', () => g('border'))
  set('status_bar', () => g('title_bar'))
  set('status_bar_border', () => g('title_bar_border'))
  set('overlay')
  set('window_border', () => g('border'))

  // Alpha clamps applied last in apply_config.
  for (const [f, max] of [
    ['list_active', 0.2],
    ['table_active', 0.2],
    ['selection', 0.3],
  ] as const) {
    const c = g(f)
    out.set(f, { ...c, a: Math.min(c.a, max) })
  }

  if (missing.length) {
    console.error(`no value or fallback for: ${missing.join(', ')}`)
    process.exit(1)
  }

  const result: Record<string, string> = {}
  const unmapped: string[] = []
  for (const key of COLOR_KEYS) {
    const f = keyToField.get(key)
    const c = f ? out.get(f) : undefined
    if (!c) {
      unmapped.push(key)
      continue
    }
    const rawValue = raw.get(f as string)
    // Literal hex values from the theme file are kept exactly as written (lowercased).
    const clamped = ['list_active', 'table_active', 'selection'].includes(f as string)
    result[key] = rawValue?.startsWith('#') && !clamped ? rawValue.toLowerCase() : toHex(c)
  }
  if (unmapped.length) {
    console.error(`keys not derivable: ${unmapped.join(', ')}`)
    process.exit(1)
  }
  return result
}

function emit(
  file: string,
  exportName: string,
  mode: string,
  colors: Record<string, string>,
): void {
  const body = COLOR_KEYS.map((k) => `  '${k}': '${colors[k]}',`).join('\n')
  const text = `// GENERATED by packages/theme-core/scripts/gen-base.ts. Do not edit by hand.
// Source: gpui-component 0.7.0 theme/default-theme.json ("Default ${mode === 'dark' ? 'Dark' : 'Light'}"),
// default-colors.json and the apply_config fallbacks in schema.rs.
// gpui-component data is Apache-2.0 licensed.
import type { ColorKey } from './keys.ts'

export const ${exportName}: Record<ColorKey, string> = {
${body}
}
`
  fs.writeFileSync(path.join(OUT, file), text)
}

for (const cfg of themeSet.themes) {
  const colors = build(cfg)
  if (cfg.mode === 'dark') emit('base-dark.ts', 'BASE_DARK', 'dark', colors)
  else emit('base-light.ts', 'BASE_LIGHT', 'light', colors)
}
