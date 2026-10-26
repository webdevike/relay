import { MENTION_EVERYONE, mentionSpans, type Mentionable } from '@evaos/contract'
import { MENTION_SCHEME } from '../chat/markdown/Markdown'
import { ISAAC_PERSON } from './roster'
import type { RoomAgent } from './types'

/** Everyone a room message can mention, Isaac included. */
export const mentionables = (agents: readonly RoomAgent[]): (Mentionable & { color: string })[] => [
  ...agents.map((a) => ({ id: a.id, name: a.name, color: a.color })),
  { id: ISAAC_PERSON.id, name: ISAAC_PERSON.name, color: ISAAC_PERSON.color },
]

/**
 * `@Mara` -> `[@Mara](mention:orange)` so the Markdown component draws a pill. Code spans and
 * fences are left alone.
 */
export function mentionMarkdown(text: string, agents: readonly RoomAgent[]): string {
  const people = mentionables(agents)
  const colorOf = (id: string): string =>
    id === MENTION_EVERYONE ? 'gray' : (people.find((p) => p.id === id)?.color ?? 'gray')
  // Split on backtick runs: even segments are prose, odd ones are code.
  return text
    .split(/(`+[^`]*`+)/)
    .map((seg, i) => {
      if (i % 2 === 1) return seg
      let out = ''
      let at = 0
      for (const s of mentionSpans(seg, people)) {
        out += seg.slice(at, s.start)
        out += `[${seg.slice(s.start, s.end)}](${MENTION_SCHEME}${colorOf(s.id)})`
        at = s.end
      }
      return out + seg.slice(at)
    })
    .join('')
}

export interface MentionQuery {
  /** Index of the `@`. */
  start: number
  /** What was typed after it so far, lowercased. */
  query: string
}

/**
 * The `@word` the caret is at the end of, when the `@` starts the text or follows whitespace;
 * null otherwise (no picker).
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const head = text.slice(0, caret)
  const m = /(^|\s)@([A-Za-z]*)$/.exec(head)
  if (!m) return null
  return { start: head.length - m[2]!.length - 1, query: m[2]!.toLowerCase() }
}

/** The people whose first name starts with the query, in roster order. */
export function mentionChoices<T extends { name: string }>(
  people: readonly T[],
  query: string,
): T[] {
  return people.filter((p) => p.name.toLowerCase().split(/\s+/)[0]!.startsWith(query))
}

/** Replaces the `@query` at `q` with `@First ` and puts the caret after it. */
export function insertMention(
  text: string,
  caret: number,
  q: MentionQuery,
  name: string,
): { text: string; caret: number } {
  const first = name.split(/\s+/)[0] ?? name
  const token = `@${first} `
  const next = text.slice(0, q.start) + token + text.slice(caret)
  return { text: next, caret: q.start + token.length }
}

/** Types `insert` at the caret (Escape leaves the picker by ending the @word with a space). */
export function insertRaw(
  text: string,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length }
}
