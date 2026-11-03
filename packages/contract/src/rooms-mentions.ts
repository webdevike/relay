/** Someone a message can mention: an agent, or Isaac in the renderer's case. */
export interface Mentionable {
  id: string
  /** "Mara Voss"; matched on the first name, optionally followed by the last. */
  name: string
}

export const MENTION_EVERYONE = 'everyone'

const MENTION_RE = /@([A-Za-z]+)(?:[ \t]+([A-Za-z]+))?/g

/**
 * Who `text` mentions: `@First` or `@First Last`, case-insensitive against `people`; `@everyone`
 * and `@all` are the whole room (returned alone as `everyone`). Unknown names are ignored; ids
 * come back once each, in order of first mention.
 */
export function mentionsIn(text: string, people: readonly Mentionable[]): string[] {
  const out: string[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    const first = m[1]!.toLowerCase()
    if (first === 'everyone' || first === 'all') return [MENTION_EVERYONE]
    // The first name alone binds; "@Mara said" and "@Mara Voss" both mention Mara.
    const hit = people.find((p) => p.name.toLowerCase().split(/\s+/)[0] === first)
    if (hit && !out.includes(hit.id)) out.push(hit.id)
  }
  return out
}

/**
 * The spans of `text` that are mentions of `people`, for rendering: [start, end, id]. `@First
 * Last` is one span when Last matches; otherwise the span is `@First` alone.
 */
export function mentionSpans(
  text: string,
  people: readonly Mentionable[],
): { start: number; end: number; id: string }[] {
  const spans: { start: number; end: number; id: string }[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    const first = m[1]!.toLowerCase()
    const last = m[2]?.toLowerCase()
    const start = m.index
    if (first === 'everyone' || first === 'all') {
      spans.push({ start, end: start + 1 + m[1]!.length, id: MENTION_EVERYONE })
      continue
    }
    const hit = people.find((p) => p.name.toLowerCase().split(/\s+/)[0] === first)
    if (!hit) continue
    const lastName = hit.name.toLowerCase().split(/\s+/)[1]
    const full = last !== undefined && lastName !== undefined && last === lastName
    spans.push({ start, end: full ? start + m[0].length : start + 1 + m[1]!.length, id: hit.id })
  }
  return spans
}
