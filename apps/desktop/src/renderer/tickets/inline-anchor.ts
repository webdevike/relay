// Where an inline comment's quote sits in the rendered description (PLAN T3.1). Linear keeps only
// the quoted words (`quotedText`), so Relay finds them in the description as rendered, ignoring
// whitespace and inline formatting, and picks the occurrence by the `{prefix, suffix}` it saved
// when the comment was made (host `tickets/anchors.json`). Without that context a quote found
// twice shows on its first match, marked ambiguous; one no longer found is "on removed text".
// Pure: offsets are into the rendered text (the description's text nodes joined), no DOM.

/** The words around a quote when it was made, whitespace removed (survives reflow and formatting). */
export interface AnchorContext {
  prefix: string
  suffix: string
}

/** How much context is kept on each side of a quote. */
export const CONTEXT_CHARS = 32

/** A span of the rendered text, `[start, end)`. */
export interface Span {
  start: number
  end: number
}

export type Placement = ({ kind: 'anchored'; ambiguous: boolean } & Span) | { kind: 'removed' }

/** The text with whitespace removed, and where each kept character was in the original. */
function squeeze(text: string): { s: string; at: number[] } {
  let s = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (/\s/.test(ch)) continue
    s += ch
    at.push(i)
  }
  return { s, at }
}

const strip = (text: string): string => squeeze(text).s

/**
 * The quote as the description renders it: Markdown emphasis, code and strike markers and link
 * targets removed (`**save**` -> `save`, `[docs](https://x)` -> `docs`), whitespace dropped.
 */
export function plainQuote(quote: string): string {
  const text = quote
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
  return strip(text)
}

/** Every occurrence of `quote` in `text` (rendered offsets), first first. */
export function findAll(text: string, quote: string): Span[] {
  const q = plainQuote(quote)
  if (!q) return []
  const { s, at } = squeeze(text)
  const out: Span[] = []
  for (let i = s.indexOf(q); i !== -1; i = s.indexOf(q, i + 1)) {
    out.push({ start: at[i]!, end: at[i + q.length - 1]! + 1 })
  }
  return out
}

/** The context to save for a quote at `span` of `text`. */
export function contextAt(text: string, span: Span): AnchorContext {
  return {
    prefix: strip(text.slice(0, span.start)).slice(-CONTEXT_CHARS),
    suffix: strip(text.slice(span.end)).slice(0, CONTEXT_CHARS),
  }
}

/** How many characters `a` and `b` share at their ends (`fromEnd`) or starts. */
function shared(a: string, b: string, fromEnd: boolean): number {
  let n = 0
  const max = Math.min(a.length, b.length)
  while (n < max) {
    const x = fromEnd ? a[a.length - 1 - n] : a[n]
    const y = fromEnd ? b[b.length - 1 - n] : b[n]
    if (x !== y) break
    n += 1
  }
  return n
}

/** How well the text around `span` matches the saved context. */
function score(text: string, span: Span, ctx: AnchorContext): number {
  const here = contextAt(text, span)
  return shared(here.prefix, ctx.prefix, true) + shared(here.suffix, ctx.suffix, false)
}

/** The occurrence the saved context points at, or null when none (or several) fit best. */
function byContext(text: string, hits: Span[], ctx: AnchorContext): Span | null {
  const scored = hits.map((h) => ({ h, n: score(text, h, ctx) }))
  const best = Math.max(...scored.map((x) => x.n))
  const top = scored.filter((x) => x.n === best)
  return best > 0 && top.length === 1 ? top[0]!.h : null
}

/** Where a quote shows: its one match, the match its context picks, else the first (ambiguous). */
export function placeQuote(
  text: string,
  quote: string,
  ctx: AnchorContext | null | undefined,
): Placement {
  const hits = findAll(text, quote)
  if (hits.length === 0) return { kind: 'removed' }
  if (hits.length === 1) return { kind: 'anchored', ambiguous: false, ...hits[0]! }
  const picked = ctx ? byContext(text, hits, ctx) : null
  return picked
    ? { kind: 'anchored', ambiguous: false, ...picked }
    : { kind: 'anchored', ambiguous: true, ...hits[0]! }
}

/** An inline thread's root as anchoring needs it. */
export interface InlineRoot {
  id: string
  quotedText: string | null
  anchor?: AnchorContext | null
}

export interface PlacedThread extends Span {
  id: string
  ambiguous: boolean
}

/** Each inline root placed in `text`: anchored ones by position, the rest on removed text. */
export function placeThreads(
  text: string,
  roots: readonly InlineRoot[],
): { anchored: PlacedThread[]; removed: string[] } {
  const anchored: PlacedThread[] = []
  const removed: string[] = []
  for (const r of roots) {
    const p = placeQuote(text, r.quotedText ?? '', r.anchor)
    if (p.kind === 'removed') removed.push(r.id)
    else anchored.push({ id: r.id, start: p.start, end: p.end, ambiguous: p.ambiguous })
  }
  anchored.sort((a, b) => a.start - b.start)
  return { anchored, removed }
}

/** Where rendered offset `offset` falls among text pieces of these lengths (end-inclusive). */
export function locate(
  lengths: readonly number[],
  offset: number,
): { index: number; offset: number } | null {
  let rest = offset
  for (let i = 0; i < lengths.length; i += 1) {
    const n = lengths[i]!
    if (rest <= n) return { index: i, offset: rest }
    rest -= n
  }
  return null
}
