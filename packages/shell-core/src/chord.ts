/** Hotkey chord normalisation and the README chord table (D-11, D-14). */

export interface KeyLike {
  key: string
  code: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

/** The subset of Electron's `Input` this needs. */
export interface InputLike {
  type: string
  key: string
  code?: string
  meta?: boolean
  control?: boolean
  shift?: boolean
  alt?: boolean
  isAutoRepeat?: boolean
}

const BARE_MODIFIERS = new Set(['meta', 'shift', 'control', 'alt', 'os', 'altgraph', 'capslock'])

function keyPart(key: string, code: string | undefined): string {
  if (code) {
    const digit = /^Digit([0-9])$/.exec(code)
    if (digit) return digit[1]!
    if (code === 'BracketLeft') return '['
    if (code === 'BracketRight') return ']'
    const letter = /^Key([A-Z])$/.exec(code)
    if (letter) return letter[1]!.toLowerCase()
  }
  if (key === 'Escape') return 'escape'
  return key.toLowerCase()
}

function build(
  key: string,
  code: string | undefined,
  m: boolean | undefined,
  c: boolean | undefined,
  a: boolean | undefined,
  s: boolean | undefined,
): string | null {
  if (BARE_MODIFIERS.has(key.toLowerCase())) return null
  const parts: string[] = []
  if (m) parts.push('cmd')
  if (c) parts.push('ctrl')
  if (a) parts.push('alt')
  if (s) parts.push('shift')
  parts.push(keyPart(key, code))
  return parts.join('+')
}

export function chordOf(e: KeyLike): string | null {
  if (e.isComposing) return null
  return build(e.key, e.code, e.metaKey, e.ctrlKey, e.altKey, e.shiftKey)
}

export function chordOfInput(input: InputLike): string | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null
  return build(input.key, input.code, input.meta, input.control, input.alt, input.shift)
}

export type ActionId =
  | 'new-todo'
  | 'reload'
  | 'toggle-sidebar'
  | 'toggle-panel'
  | 'toggle-eregon'
  | 'toggle-search'
  | 'focus-search'
  | 'new-tab'
  | 'close-tab'
  | 'history-back'
  | 'history-forward'
  | 'save'
  | 'pick-model-1'
  | 'pick-model-2'
  | 'pick-model-3'
  | 'pick-model-4'
  | 'pick-model-5'
  | 'pick-model-6'
  | 'pick-model-7'
  | 'pick-model-8'
  | 'pick-model-9'
  | 'copy-page-url'
  | 'dismiss'

export const GLOBAL_CHORDS: ReadonlyArray<{ chord: string; action: ActionId }> = [
  { chord: 'cmd+n', action: 'new-todo' },
  { chord: 'cmd+r', action: 'reload' },
  { chord: 'cmd+b', action: 'toggle-sidebar' },
  { chord: 'cmd+shift+b', action: 'toggle-panel' },
  { chord: 'cmd+j', action: 'toggle-eregon' },
  { chord: 'cmd+k', action: 'toggle-search' },
  { chord: 'cmd+f', action: 'focus-search' },
  { chord: 'cmd+t', action: 'new-tab' },
  { chord: 'cmd+w', action: 'close-tab' },
  { chord: 'cmd+[', action: 'history-back' },
  { chord: 'cmd+]', action: 'history-forward' },
  { chord: 'cmd+s', action: 'save' },
  { chord: 'cmd+1', action: 'pick-model-1' },
  { chord: 'cmd+2', action: 'pick-model-2' },
  { chord: 'cmd+3', action: 'pick-model-3' },
  { chord: 'cmd+4', action: 'pick-model-4' },
  { chord: 'cmd+5', action: 'pick-model-5' },
  { chord: 'cmd+6', action: 'pick-model-6' },
  { chord: 'cmd+7', action: 'pick-model-7' },
  { chord: 'cmd+8', action: 'pick-model-8' },
  { chord: 'cmd+9', action: 'pick-model-9' },
  { chord: 'cmd+shift+c', action: 'copy-page-url' },
  { chord: 'escape', action: 'dismiss' },
]

const BY_CHORD = new Map(GLOBAL_CHORDS.map((c) => [c.chord, c.action]))

export function actionFor(chord: string): ActionId | null {
  return BY_CHORD.get(chord) ?? null
}

/** Chords a focused terminal lets escape to the app; the rest belong to the shell program. */
export const TERMINAL_PASS_THROUGH = [
  'cmd+shift+b',
  'cmd+b',
  'cmd+k',
  'cmd+j',
  'cmd+t',
  'cmd+w',
  'cmd+q',
] as const

/** Browser panel page scope. cmd+[ and cmd+] belong to main tab history (D-14). */
export const PAGE_BROWSER_CHORDS = {
  'cmd+l': 'focus-address',
  'cmd+alt+i': 'devtools',
} as const

export const FORWARD_FROM_GUEST: ReadonlySet<string> = new Set([
  ...GLOBAL_CHORDS.map((c) => c.chord).filter((c) => c !== 'escape'),
  'cmd+l',
])

const NATIVE_EDIT = new Set(['cmd+c', 'cmd+v', 'cmd+x', 'cmd+a', 'cmd+z', 'cmd+shift+z'])

export function isNativeEditChord(chord: string): boolean {
  return NATIVE_EDIT.has(chord)
}
