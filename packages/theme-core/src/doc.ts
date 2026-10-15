import { COLOR_KEYS, type ColorKey } from './keys'

export type Appearance = 'light' | 'dark' | 'system'
export type Edits = Partial<Record<ColorKey, string>>

export interface ThemeDoc {
  base: string
  shared: Edits
  light: { edits: Edits }
  dark: { edits: Edits }
  app: { appearance: Appearance }
  /** The original parsed object, so main can merge-write keys this app does not know. */
  raw: Record<string, unknown>
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i
const KEY_SET: ReadonlySet<string> = new Set(COLOR_KEYS)

export function defaultDoc(): ThemeDoc {
  return {
    base: 'EvaOS',
    shared: {},
    light: { edits: {} },
    dark: { edits: {} },
    app: { appearance: 'system' },
    raw: {},
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Keeps only known color keys with hex values (T-02-11: nothing else reaches CSS variables). */
function parseEdits(v: unknown): Edits {
  const out: Record<string, string> = {}
  if (!isRecord(v)) return out
  for (const [k, val] of Object.entries(v)) {
    if (KEY_SET.has(k) && typeof val === 'string' && HEX.test(val)) out[k] = val
  }
  return out as Edits
}

/** Tolerant: never throws, falls back to the default doc (T-02-13). */
export function parseThemeDoc(value: unknown): ThemeDoc {
  const doc = defaultDoc()
  if (!isRecord(value)) return doc
  doc.raw = value
  if (typeof value.base === 'string' && value.base.length > 0) doc.base = value.base
  doc.shared = parseEdits(value.shared)
  if (isRecord(value.light)) doc.light = { edits: parseEdits(value.light.edits) }
  if (isRecord(value.dark)) doc.dark = { edits: parseEdits(value.dark.edits) }
  if (isRecord(value.app)) {
    const a = value.app.appearance
    if (a === 'light' || a === 'dark' || a === 'system') doc.app = { appearance: a }
  }
  return doc
}

export function resolveMode(appearance: Appearance, prefersDark: boolean): 'light' | 'dark' {
  if (appearance === 'system') return prefersDark ? 'dark' : 'light'
  return appearance
}
