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
    if (code === 'Backslash') return '\\'
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
  | 'focus-search'
  | 'new-tab'
  | 'close-tab'
  | 'history-back'
  | 'history-forward'
  | 'dismiss'
  | 'split-right'
  | 'split-down'
  | 'focus-pane-left'
  | 'focus-pane-right'
  | 'focus-pane-up'
  | 'focus-pane-down'
  | 'close-pane'
  | 'zoom-pane'

export const GLOBAL_CHORDS: ReadonlyArray<{ chord: string; action: ActionId }> = [
  { chord: 'cmd+n', action: 'new-todo' },
  { chord: 'cmd+r', action: 'reload' },
  { chord: 'cmd+b', action: 'toggle-sidebar' },
  { chord: 'cmd+shift+b', action: 'toggle-panel' },
  { chord: 'cmd+f', action: 'focus-search' },
  { chord: 'cmd+t', action: 'new-tab' },
  { chord: 'cmd+w', action: 'close-tab' },
  { chord: 'cmd+[', action: 'history-back' },
  { chord: 'cmd+]', action: 'history-forward' },
  { chord: 'escape', action: 'dismiss' },
  // Panes (tiling): split the focused pane, move between panes, close or maximize it.
  { chord: 'cmd+\\', action: 'split-right' },
  { chord: 'cmd+shift+\\', action: 'split-down' },
  { chord: 'cmd+alt+arrowleft', action: 'focus-pane-left' },
  { chord: 'cmd+alt+arrowright', action: 'focus-pane-right' },
  { chord: 'cmd+alt+arrowup', action: 'focus-pane-up' },
  { chord: 'cmd+alt+arrowdown', action: 'focus-pane-down' },
  { chord: 'cmd+alt+w', action: 'close-pane' },
  { chord: 'cmd+alt+enter', action: 'zoom-pane' },
]

const BY_CHORD = new Map(GLOBAL_CHORDS.map((c) => [c.chord, c.action]))

export function actionFor(chord: string): ActionId | null {
  return BY_CHORD.get(chord) ?? null
}

/** Chords a focused terminal lets escape to the app; the rest belong to the shell program. */
export const TERMINAL_PASS_THROUGH = ['cmd+shift+b', 'cmd+b', 'cmd+t', 'cmd+w', 'cmd+q'] as const

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
