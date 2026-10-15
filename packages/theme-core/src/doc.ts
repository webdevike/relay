import { COLOR_KEYS, type ColorKey } from './keys'
import { hasThemeFamily } from './catalog'
import { HIGHLIGHT_COLOR_KEYS, parseHighlight, validateHighlight, type HighlightEdits } from './highlight'
import { isThemeRecord } from './record'

export type Appearance = 'light' | 'dark' | 'system'
export type Edits = Partial<Record<ColorKey, string>>
export interface SharedEdits extends Edits {
  'font.family'?: string
  'font.size'?: number
  'mono_font.family'?: string
  'mono_font.size'?: number
  radius?: number
  'radius.lg'?: number
  shadow?: boolean
}
export interface ModeEdits extends Edits { highlight?: HighlightEdits }
export interface ThemeDoc {
  base: string
  shared: SharedEdits
  light: { edits: ModeEdits }
  dark: { edits: ModeEdits }
  app: { appearance: Appearance }
  /** Original fields not owned by this editor survive merge-writes. */
  raw: Record<string, unknown>
}

export const HEX_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i
export const SHARED_KEYS = ['font.family', 'font.size', 'mono_font.family', 'mono_font.size', 'radius', 'radius.lg', 'shadow'] as const
const FONT_FAMILY = /^[^"'\\;{}\u0000-\u001f\u007f]{1,200}$/u
const SHARED_LIMITS: Record<string, readonly [number, number]> = {
  'font.size': [10, 24], 'mono_font.size': [9, 24], radius: [0, 24], 'radius.lg': [0, 32],
}

export function defaultDoc(): ThemeDoc {
  return { base: 'EvaOS', shared: {}, light: { edits: {} }, dark: { edits: {} }, app: { appearance: 'system' }, raw: {} }
}
function validShared(key: string, value: unknown): boolean {
  if (key === 'shadow') return typeof value === 'boolean'
  if (key === 'font.family' || key === 'mono_font.family') return typeof value === 'string' && FONT_FAMILY.test(value) && value.trim().length > 0
  const limit = SHARED_LIMITS[key]
  return !!limit && typeof value === 'number' && Number.isFinite(value) && value >= limit[0] && value <= limit[1]
}
function parseEdits(value: unknown): Edits {
  const out: Edits = {}
  if (!isThemeRecord(value)) return out
  // Native docs nest colors; older Electron docs store them directly.
  const colors = isThemeRecord(value.colors) ? { ...value, ...value.colors } : value
  for (const key of COLOR_KEYS) {
    const color = colors[key]
    if (typeof color === 'string' && HEX_COLOR.test(color)) out[key] = color
  }
  return out
}
function parseMode(value: unknown): { edits: ModeEdits } {
  const edits = isThemeRecord(value) && isThemeRecord(value.edits) ? value.edits : {}
  const highlight = parseHighlight(edits.highlight)
  return { edits: { ...parseEdits(edits), ...(highlight ? { highlight } : {}) } }
}
/** Tolerant on load; untrusted values never reach CSS. Saving uses validateThemeDoc. */
export function parseThemeDoc(value: unknown): ThemeDoc {
  const doc = defaultDoc()
  if (!isThemeRecord(value)) return doc
  doc.raw = value
  if (typeof value.base === 'string' && value.base.length > 0) doc.base = value.base
  doc.shared = parseEdits(value.shared)
  if (isThemeRecord(value.shared)) {
    for (const key of SHARED_KEYS) {
      const v = value.shared[key]
      if (validShared(key, v)) Object.assign(doc.shared, { [key]: v })
    }
  }
  doc.light = parseMode(value.light)
  doc.dark = parseMode(value.dark)
  if (isThemeRecord(value.app)) {
    const a = value.app.appearance
    if (a === 'light' || a === 'dark' || a === 'system') doc.app = { appearance: a }
  }
  return doc
}
function invalid(path: string): never {
  throw Object.assign(new Error(`Invalid theme field: ${path}`), { code: 'invalid-theme' })
}
function validateJson(value: unknown, path: string, parents: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || parents.has(value)) invalid(path)
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid(path)
  parents.add(value)
  for (const [key, child] of Object.entries(value)) validateJson(child, `${path}.${key}`, parents)
  parents.delete(value)
}
/** Strict editor boundary: validate all known fields without discarding future fields. */
export function validateThemeDoc(value: unknown): ThemeDoc {
  validateJson(value, 'doc', new WeakSet())
  if (!isThemeRecord(value)) invalid('doc')
  if (typeof value.base !== 'string' || !hasThemeFamily(value.base)) invalid('base')
  if (!isThemeRecord(value.shared)) invalid('shared')
  const validateColors = (edits: Record<string, unknown>, path: string) => {
    for (const key of COLOR_KEYS) {
      if (Object.hasOwn(edits, key) && (typeof edits[key] !== 'string' || !HEX_COLOR.test(edits[key] as string))) invalid(`${path}.${key}`)
    }
    if (Object.hasOwn(edits, 'colors')) {
      if (!isThemeRecord(edits.colors)) invalid(`${path}.colors`)
      for (const key of COLOR_KEYS) {
        const color = edits.colors[key]
        if (Object.hasOwn(edits.colors, key) && (typeof color !== 'string' || !HEX_COLOR.test(color))) invalid(`${path}.colors.${key}`)
      }
    }
  }
  validateColors(value.shared, 'shared')
  for (const key of SHARED_KEYS) if (Object.hasOwn(value.shared, key) && !validShared(key, value.shared[key])) invalid(`shared.${key}`)
  for (const mode of ['light', 'dark'] as const) {
    const section = value[mode]
    if (!isThemeRecord(section) || !isThemeRecord(section.edits)) invalid(`${mode}.edits`)
    validateColors(section.edits, `${mode}.edits`)
    if (Object.hasOwn(section.edits, 'highlight')) validateHighlight(section.edits.highlight, `${mode}.edits.highlight`)
  }
  if (!isThemeRecord(value.app) || !['light', 'dark', 'system'].includes(value.app.appearance as string)) invalid('app.appearance')
  return parseThemeDoc(value)
}

const record = (value: unknown): Record<string, unknown> => isThemeRecord(value) ? value : {}
/** Merge unknown fields recursively without invoking prototype setters. */
export function mergeThemeFields(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const out = { ...previous }
  for (const [key, value] of Object.entries(incoming)) {
    Object.defineProperty(out, key, { value: isThemeRecord(value) ? mergeThemeFields(record(previous[key]), value) : value, enumerable: true, configurable: true, writable: true })
  }
  return out
}
function serializeEdits(previous: unknown, edits: Edits): Record<string, unknown> {
  const out = { ...record(previous) }
  const colors = { ...record(out.colors) }
  for (const key of COLOR_KEYS) { delete out[key]; delete colors[key] }
  for (const key of COLOR_KEYS) if (edits[key] !== undefined) colors[key] = edits[key]
  out.colors = colors
  return out
}
/** Canonical native document; absence of an owned override removes it (Reset/Undo). */
export function serializeThemeDoc(doc: ThemeDoc, previous: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = mergeThemeFields(previous, doc.raw)
  const shared = serializeEdits(raw.shared, doc.shared)
  // Shared colors retain the existing Electron layout; shared shape keys use native names.
  const sharedColors = record(shared.colors)
  for (const key of COLOR_KEYS) if (doc.shared[key] !== undefined) shared[key] = doc.shared[key]
  for (const key of COLOR_KEYS) delete sharedColors[key]
  if (Object.keys(sharedColors).length === 0) delete shared.colors
  for (const key of SHARED_KEYS) { delete shared[key]; if (doc.shared[key] !== undefined) shared[key] = doc.shared[key] }
  const mode = (name: 'light' | 'dark') => {
    const section = record(raw[name])
    const edits = serializeEdits(section.edits, doc[name].edits)
    const highlight = { ...record(edits.highlight) }
    for (const key of HIGHLIGHT_COLOR_KEYS) delete highlight[key]
    const syntax = Object.fromEntries(Object.entries(record(highlight.syntax)).flatMap(([token, value]) => {
      const style = { ...record(value) }
      delete style.color
      delete style.font_style
      delete style.font_weight
      return Object.keys(style).length ? [[token, style]] : []
    }))
    delete highlight.syntax
    if (Object.keys(syntax).length) highlight.syntax = syntax
    const mergedHighlight = mergeThemeFields(highlight, doc[name].edits.highlight ?? {})
    delete edits.highlight
    if (Object.keys(mergedHighlight).length) edits.highlight = mergedHighlight
    return { ...section, edits }
  }
  return { ...raw, base: doc.base, shared, light: mode('light'), dark: mode('dark'), app: { ...record(raw.app), ...doc.app } }
}
export function resolveMode(appearance: Appearance, prefersDark: boolean): 'light' | 'dark' {
  return appearance === 'system' ? (prefersDark ? 'dark' : 'light') : appearance
}
