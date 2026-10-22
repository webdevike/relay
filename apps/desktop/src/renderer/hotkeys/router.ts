import {
  GLOBAL_CHORDS,
  chordOf,
  createScopes,
  isNativeEditChord,
  terminalClaim,
  type ActionId,
  type ScopeHandler,
} from '@evaos/shell-core'
import { on } from '../ipc'
import { dismissTop } from './dismiss'

/** The one hotkey router (D-11). Dispatch order: overlay, terminal, page, global. */
const scopes = createScopes()

const LOG_CAP = 200
const actions = new Map<string, Array<() => void>>()
let fromGuestNow = false

/** True while the chord being dispatched was forwarded from a guest page. */
export function isDispatchFromGuest(): boolean {
  return fromGuestNow
}

function log(chord: string, action: string): void {
  const buf = window.__evaosHotkeys
  if (!Array.isArray(buf)) return
  buf.push({ chord, action, at: Date.now() })
  if (buf.length > LOG_CAP) buf.splice(0, buf.length - LOG_CAP)
}

export function registerAction(id: ActionId, fn: () => void): () => void {
  const list = actions.get(id) ?? []
  list.push(fn)
  actions.set(id, list)
  return () => {
    const l = actions.get(id)
    if (!l) return
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }
}

/** Runs the most recently registered handler for an implemented action. */
export function runAction(id: ActionId, chord?: string): void {
  const c = chord ?? GLOBAL_CHORDS.find((g) => g.action === id)?.chord ?? ''
  log(c, id)
  const list = actions.get(id)
  const fn = list?.[list.length - 1]
  if (fn) fn()
}

for (const { chord, action } of GLOBAL_CHORDS) {
  scopes.register('global', chord, () => {
    if (action === 'dismiss') {
      log(chord, action)
      return dismissTop() ? 'consumed' : false
    }
    runAction(action, chord)
    return 'consumed'
  })
}

export function registerPageChord(chord: string, fn: ScopeHandler): () => void {
  return scopes.register('page', chord, fn)
}

export function registerOverlayChord(chord: string, fn: ScopeHandler): () => void {
  return scopes.register('overlay', chord, fn)
}

/** A focused terminal yields every chord except the pass-through list. */
export function registerTerminalScope(passThrough: readonly string[]): () => void {
  return scopes.register('terminal', '*', terminalClaim(passThrough))
}

let chordLock: ((chord: string) => boolean) | null = null

/** While set, only chords for which `allow` is true dispatch; the rest are consumed (the gate). */
export function setChordLock(allow: ((chord: string) => boolean) | null): void {
  chordLock = allow
}

export function dispatchChord(
  chord: string,
  opts: { fromGuest: boolean; event?: Pick<Event, 'preventDefault' | 'stopPropagation'> },
): boolean {
  if (chordLock && !chordLock(chord)) {
    opts.event?.preventDefault()
    opts.event?.stopPropagation()
    return true
  }
  fromGuestNow = opts.fromGuest
  try {
    const d = scopes.dispatch(chord)
    if (d.result !== 'consumed') return false
    opts.event?.preventDefault()
    opts.event?.stopPropagation()
    return true
  } finally {
    fromGuestNow = false
  }
}

/** True when plain digits belong to the focused element (inputs, editors, the terminal). */
function isTypingTarget(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.closest('.xterm') !== null
}

function onKeyDown(e: KeyboardEvent): void {
  // Held keys must not retrigger actions (Cmd+T, Cmd+W); main drops guest repeats the same way.
  if (e.isComposing || e.repeat) return
  const chord = chordOf(e)
  if (!chord || isNativeEditChord(chord)) return
  // Only cmd/ctrl/alt chords and Escape; plain typing is never touched. The one exception is a
  // bare 1 to 4 outside any text input, which page handlers (question cards) may claim.
  const pickDigit = /^[1-4]$/.test(chord) && !isTypingTarget()
  if (
    !pickDigit &&
    chord !== 'escape' &&
    !/^(cmd|ctrl|alt)\+/.test(chord) &&
    !/\+(cmd|ctrl|alt)\+/.test(chord)
  )
    return
  dispatchChord(chord, { fromGuest: false, event: e })
}

let disposer: (() => void) | null = null

/** Idempotent: attaches the single capture keydown listener and the app.hotkey subscription. */
export function startHotkeyRouter(): () => void {
  if (disposer) return disposer
  window.addEventListener('keydown', onKeyDown, true)
  const off = on('app.hotkey', (p) => {
    dispatchChord(p.chord, { fromGuest: p.fromGuest })
  })
  disposer = () => {
    window.removeEventListener('keydown', onKeyDown, true)
    off()
    disposer = null
  }
  return disposer
}
