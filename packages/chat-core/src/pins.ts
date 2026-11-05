// Pins: things worth keeping at hand from a conversation (a URL to copy, a code, a number, a path, a
// command, a PR, a whole message). A pin is not a second store: it is an artifact of the thread that
// is `pinned` (a `pin`-kind artifact carries its own label and value; a pinned PR, ticket, link or
// file artifact is shown as a pin of its own kind). Mirrored from Relay's protocol (relay
// packages/protocol/src/pins.ts): keep the two, line for line, in sync.
//
// Assistants without a Relay tool pin with one line in a reply, `[[pin: Staging login | https://...]]`:
// `splitPins` reads those lines and cuts them from the shown text (also while they stream in); the
// host reads the same lines from the transcripts and pins them.
import {
  MAX_PIN_LABEL,
  MAX_PIN_VALUE,
  type Artifact,
  type ArtifactPinNote,
  type PinKind,
} from './artifacts'

/** One pin as the rail, the popover and the phone's chips show it. */
export interface Pin {
  /** The artifact's id: `pin:<hash>` for a snippet, else the pinned artifact's own. */
  id: string
  kind: PinKind
  label: string
  value: string
  /** Bubble key (`<role>@<omp ms>`) of the message it came from, when known. */
  source?: string
  /** `isaac`, or the assistant's id / chat name. */
  pinnedBy: string
  at: number
}

/** Pins one reply may make by markup; the rest are ignored. */
export const MAX_MARKUP_PINS = 5

/** `pin:` and 16 hex digits of two FNV-1a hashes of the kind and value: the same snippet is one pin. */
export function pinId(kind: PinKind, value: string): string {
  const text = `${kind}\n${value}`
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0
  }
  return `pin:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

const URL_ONLY = /^https?:\/\/\S+$/
const PR_URL = /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/?#]\S*)?$/
const ITEM_URL = /^https?:\/\/linear\.app\/[^/\s]+\/issue\/\S+$/
const PATH_ONLY = /^(?:~\/|\/(?!\/))\S+$/
const NUMBER_ONLY = /^[+-]?[$€£]?\d[\d,_]*(?:\.\d+)?%?$/
const PHONE_LIKE = /^\+?\d[\d\s().-]{4,}$/

/** The kind a bare value reads as: a PR or ticket link, a link, a path, a number, a command, else text. */
export function inferPinKind(value: string): PinKind {
  const v = value.trim()
  if (PR_URL.test(v)) return 'pr'
  if (ITEM_URL.test(v)) return 'item'
  if (URL_ONLY.test(v)) return 'link'
  if (PATH_ONLY.test(v)) return 'file'
  if (NUMBER_ONLY.test(v) || PHONE_LIKE.test(v)) return 'number'
  if (v.includes('\n') || /^\$ \S/.test(v)) return 'code'
  return 'text'
}

/** A one-line label from a message or selection: its first line, cut to `max` characters. */
export function pinLabelOf(text: string, max = 60): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find((l) => l !== '') ?? ''
  const cut = line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
  return cut === '' ? 'Pin' : cut
}

/** What to pin for text Isaac chose: its label, kind and the value cut to the pin limit. */
export function pinOfText(
  text: string,
  opts: { kind?: PinKind; label?: string } = {},
): Omit<ArtifactPinNote, 'source'> | null {
  const value = text.trim().slice(0, MAX_PIN_VALUE)
  if (value === '') return null
  const kind = opts.kind ?? inferPinKind(value)
  const label = (opts.label ?? pinLabelOf(value)).slice(0, MAX_PIN_LABEL)
  return { kind, label, value }
}

function pinFromArtifact(item: Artifact): Pin | null {
  const pinned = item.pinned
  if (pinned === undefined) return null
  const base = { id: item.id, pinnedBy: pinned.by, at: pinned.at }
  const source = item.sources[0]
  const withSource = source === undefined ? {} : { source }
  if (item.kind === 'pin') {
    if (item.pin === undefined) return null
    const { kind, label, value, source: from } = item.pin
    return { ...base, kind, label, value, ...(from === undefined ? {} : { source: from }) }
  }
  const tail = item.id.slice(item.id.indexOf(':') + 1)
  switch (item.kind) {
    case 'gh-pr':
    case 'gh-issue':
      return { ...base, kind: 'pr', label: item.title, value: item.url ?? tail, ...withSource }
    case 'linear':
      return { ...base, kind: 'item', label: item.title, value: item.url ?? tail, ...withSource }
    case 'file':
    case 'experiment':
    case 'canvas':
      return { ...base, kind: 'file', label: item.title, value: item.path ?? tail, ...withSource }
    case 'url':
    case 'drop':
    case 'image':
      return { ...base, kind: 'link', label: item.title, value: item.url ?? tail, ...withSource }
    default:
      return { ...base, kind: 'text', label: item.title, value: item.title, ...withSource }
  }
}

/** The thread's pins, newest first: every pinned artifact (snippets and pinned PRs, tickets, links, files). */
export function pinsOf(items: readonly Artifact[]): Pin[] {
  const out: Pin[] = []
  for (const item of items) {
    const pin = pinFromArtifact(item)
    if (pin !== null) out.push(pin)
  }
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
}

/** A pin the markup of a reply asks for. */
export interface PinMarkup {
  kind: PinKind
  label: string
  value: string
}

/** `label | value` (the text of a `[[pin: ...]]` token); null when either side is empty or the value is too long. */
export function parsePinBody(body: string): PinMarkup | null {
  const bar = body.indexOf('|')
  if (bar < 0) return null
  const label = body.slice(0, bar).replace(/\s+/g, ' ').trim().slice(0, MAX_PIN_LABEL)
  let value = body.slice(bar + 1).trim()
  let ticked = false
  const code = /^`([^`\n]+)`$/.exec(value)
  if (code !== null) {
    value = (code[1] ?? '').trim()
    ticked = true
  }
  if (label === '' || value === '' || value.length > MAX_PIN_VALUE) return null
  return { kind: ticked ? 'code' : inferPinKind(value), label, value }
}

const LINE = /^[ \t]*\[\[pin:([^\n]*?)\]\][ \t]*$/
const OPENER = '[[pin:'
const FENCE = /^[ \t]*(?:```|~~~)/

/** Whether `line` is a `[[pin:` token that has only partly arrived (a prefix of the opener, or the opener without its `]]`). */
function partialPin(line: string): boolean {
  const t = line.trimStart()
  if (t === '') return false
  if (OPENER.startsWith(t)) return true
  return t.startsWith(OPENER) && !t.includes(']]')
}

/**
 * The pins a reply makes and the reply without their lines. A pin is a line of its own,
 * `[[pin: label | value]]` (a value in backticks is code); lines inside a code fence are left alone,
 * and a line without a label and a value is shown as written. While the reply is `streaming`, a last
 * line that has only partly arrived is cut too, so `[[pi` never flickers in. When lines were cut the
 * text loses the blank run they leave and trailing space.
 */
export function splitPins(text: string, streaming = false): { text: string; pins: PinMarkup[] } {
  if (!text.includes('[')) return { text, pins: [] }
  const lines = text.split('\n')
  const kept: string[] = []
  const pins: PinMarkup[] = []
  const seen = new Set<string>()
  let fenced = false
  let cut = false
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      fenced = !fenced
      kept.push(line)
      return
    }
    if (!fenced) {
      const match = LINE.exec(line)
      const parsed = match === null ? null : parsePinBody(match[1] ?? '')
      if (parsed !== null) {
        cut = true
        const id = pinId(parsed.kind, parsed.value)
        if (!seen.has(id) && pins.length < MAX_MARKUP_PINS) {
          seen.add(id)
          pins.push(parsed)
        }
        return
      }
      if (streaming && i === lines.length - 1 && partialPin(line)) {
        cut = true
        return
      }
    }
    kept.push(line)
  })
  if (!cut) return { text, pins }
  return {
    text: kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd(),
    pins,
  }
}
