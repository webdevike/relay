import data from './highlight-data.json'
import { isThemeRecord as isRecord } from './record'
import type { ColorKey } from './keys'

// Copied from native theme assets and gpui-component 0.7 default-theme.json.
// Apache-2.0 attribution is retained in LICENSE-APACHE; no native checkout is read at runtime.

export const HIGHLIGHT_COLOR_KEYS = [
  'editor.foreground', 'editor.background', 'editor.active_line.background', 'editor.line_number',
  'editor.active_line_number', 'editor.invisible', 'conflict', 'created', 'hidden', 'hint',
  'modified', 'predictive', 'warning', 'editor.gutter.background',
  'error', 'error.background', 'error.border', 'warning.background', 'warning.border',
  'info', 'info.background', 'info.border', 'success', 'success.background', 'success.border',
  'hint.background', 'hint.border',
] as const
export type HighlightColorKey = typeof HIGHLIGHT_COLOR_KEYS[number]
export interface SyntaxStyle {
  color?: string
  font_style?: 'normal' | 'italic' | 'oblique'
  font_weight?: number
  [key: string]: unknown
}
export type HighlightEdits = Partial<Record<HighlightColorKey, string>> & {
  syntax?: Record<string, SyntaxStyle>
  [key: string]: unknown
}
export type HighlightTheme = Record<HighlightColorKey, string> & { syntax: Record<string, SyntaxStyle> }
export const SYNTAX_TOKEN_KEYS = [
  'attribute', 'boolean', 'comment', 'comment.doc', 'constant', 'constructor', 'embedded',
  'emphasis', 'emphasis.strong', 'enum', 'function', 'hint', 'keyword', 'label', 'link_text',
  'link_uri', 'number', 'operator', 'predictive', 'preproc', 'primary', 'property',
  'punctuation', 'punctuation.bracket', 'punctuation.delimiter', 'punctuation.list_marker',
  'punctuation.special', 'string', 'string.escape', 'string.regex', 'string.special',
  'string.special.symbol', 'tag', 'tag.doctype', 'text.code.span', 'text.literal', 'title',
  'type', 'variable', 'variable.special', 'variant',
] as const
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i

/** Parses only styles safe to use in CSS; unrecognized fields remain in the original document. */
export function parseHighlight(value: unknown): HighlightEdits | undefined {
  if (!isRecord(value)) return undefined
  const out: HighlightEdits = { ...value }
  for (const key of HIGHLIGHT_COLOR_KEYS) {
    delete out[key]
    if (typeof value[key] === 'string' && HEX.test(value[key])) out[key] = value[key]
  }
  delete out.syntax
  if (isRecord(value.syntax)) {
    out.syntax = Object.fromEntries(Object.entries(value.syntax).filter(([, v]) => isRecord(v)).map(([token, style]) => {
      const input = style as Record<string, unknown>
      const parsed: SyntaxStyle = { ...input }
      delete parsed.color
      delete parsed.font_style
      delete parsed.font_weight
      if (typeof input.color === 'string' && HEX.test(input.color)) parsed.color = input.color
      if (input.font_style === 'normal' || input.font_style === 'italic' || input.font_style === 'oblique') parsed.font_style = input.font_style
      if (typeof input.font_weight === 'number' && Number.isFinite(input.font_weight) && input.font_weight >= 100 && input.font_weight <= 900) parsed.font_weight = input.font_weight
      return [token, parsed]
    }))
  }
  return out
}
export function validateHighlight(value: unknown, path: string): void {
  function invalid(key: string): never {
    throw Object.assign(new Error(`Invalid theme field: ${path}.${key}`), { code: 'invalid-theme' })
  }
  if (!isRecord(value)) invalid('highlight')
  for (const key of HIGHLIGHT_COLOR_KEYS) if (Object.hasOwn(value, key) && (typeof value[key] !== 'string' || !HEX.test(value[key] as string))) invalid(key)
  if (Object.hasOwn(value, 'syntax')) {
    if (!isRecord(value.syntax)) invalid('syntax')
    for (const [token, style] of Object.entries(value.syntax)) {
      if (!isRecord(style)) invalid(`syntax.${token}`)
      if (Object.hasOwn(style, 'color') && (typeof style.color !== 'string' || !HEX.test(style.color))) invalid(`syntax.${token}.color`)
      if (Object.hasOwn(style, 'font_style') && !['normal', 'italic', 'oblique'].includes(style.font_style as string)) invalid(`syntax.${token}.font_style`)
      if (Object.hasOwn(style, 'font_weight') && (typeof style.font_weight !== 'number' || !Number.isFinite(style.font_weight) || style.font_weight < 100 || style.font_weight > 900)) invalid(`syntax.${token}.font_weight`)
    }
  }
}
/** Native palettes ship locally; token overrides merge by attribute, never erase inherited style. */
export function resolveHighlight(base: string, mode: 'light' | 'dark', edits?: HighlightEdits, themeColors?: Record<ColorKey, string>): HighlightTheme {
  const defaults = parseHighlight(data.Default[mode])
  const families = data as Record<string, Partial<Record<'light' | 'dark', unknown>>>
  const preset = parseHighlight(Object.hasOwn(families, base) ? families[base]?.[mode] : undefined)
  const layers = [defaults, preset, parseHighlight(edits)]
  const colors = {} as Record<HighlightColorKey, string>
  const syntax: Record<string, SyntaxStyle> = Object.fromEntries(SYNTAX_TOKEN_KEYS.map((token) => [token, {}]))
  for (const layer of layers) {
    if (!layer) continue
    for (const key of HIGHLIGHT_COLOR_KEYS) if (typeof layer[key] === 'string') colors[key] = layer[key]
    for (const [token, style] of Object.entries(layer.syntax ?? {})) {
      Object.defineProperty(syntax, token, { value: { ...(Object.hasOwn(syntax, token) ? syntax[token] : {}), ...style }, enumerable: true, configurable: true, writable: true })
    }
  }
  colors['editor.gutter.background'] ??= colors['editor.background']
  const statusColors: Record<string, string> = {
    error: themeColors?.['danger.background'] ?? colors.conflict,
    warning: themeColors?.['warning.background'] ?? colors.warning,
    info: themeColors?.['info.background'] ?? colors.hint,
    success: themeColors?.['success.background'] ?? colors.created,
    hint: colors.hint,
  }
  for (const [status, color] of Object.entries(statusColors)) {
    const key = status as HighlightColorKey
    const background = `${status}.background` as HighlightColorKey
    const border = `${status}.border` as HighlightColorKey
    colors[key] ??= color
    colors[background] ??= `${color.slice(0, 7)}33`
    colors[border] ??= color
  }
  return { ...colors, syntax }
}
