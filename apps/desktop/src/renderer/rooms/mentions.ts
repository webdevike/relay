import { MENTION_EVERYONE, mentionSpans } from '@evaos/contract'
import { MENTION_SCHEME } from '../chat/markdown/Markdown'
import { ISAAC_PERSON } from './roster'
import type { RoomAgent } from './types'

/**
 * `@Mara` -> `[@Mara](mention:orange)` so the Markdown component draws a pill (members, Isaac and
 * `@everyone`). Code spans and fences are left alone. Typing a mention is the composer's `@` menu
 * (chat/composer/at-menu.ts).
 */
export function mentionMarkdown(text: string, agents: readonly RoomAgent[]): string {
  const people = [
    ...agents.map((a) => ({ id: a.id, name: a.name, color: a.color })),
    { id: ISAAC_PERSON.id, name: ISAAC_PERSON.name, color: ISAAC_PERSON.color },
  ]
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
