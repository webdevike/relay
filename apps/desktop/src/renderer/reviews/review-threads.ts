// A PR's review comments as threads on diff lines: replies under their root, each thread keyed by
// path, side and line (an outdated thread by the line it was written on), and the private assistant
// asks made from a line found again by the place their first message names. Pure.
import type { ReviewComment } from '@evaos/contract'
import type { DiffLine, Hunk } from '@relay/protocol/unified-diff'
import type { AstraThread } from './astra-timeline'

export type DiffSide = 'LEFT' | 'RIGHT'

export interface ReviewThread {
  root: ReviewComment
  replies: ReviewComment[]
  path: string
  side: DiffSide
  /** The line it shows on: its current line, or for an outdated thread its original line. */
  line: number | null
  outdated: boolean
}

/** Roots with their replies, oldest root first; a reply whose root was cut off stands as its own root. */
export function threadsOf(comments: readonly ReviewComment[]): ReviewThread[] {
  const ids = new Set(comments.map((c) => c.id))
  const threads = new Map<number, ReviewThread>()
  const sorted = [...comments].sort((a, b) => a.at - b.at)
  for (const c of sorted) {
    if (c.inReplyTo !== null && ids.has(c.inReplyTo)) continue
    threads.set(c.id, {
      root: c,
      replies: [],
      path: c.path,
      side: c.side,
      line: c.outdated ? c.originalLine : (c.line ?? c.originalLine),
      outdated: c.outdated,
    })
  }
  for (const c of sorted) {
    if (c.inReplyTo === null) continue
    threads.get(c.inReplyTo)?.replies.push(c)
  }
  return [...threads.values()]
}

export const lineKey = (path: string, side: DiffSide, line: number): string =>
  `${path}\n${side}\n${String(line)}`

/** The keys a diff line answers to: its new line (RIGHT) and its old line (LEFT). */
function keysOf(path: string, l: DiffLine): string[] {
  return [
    ...(l.new === null ? [] : [lineKey(path, 'RIGHT', l.new)]),
    ...(l.old === null ? [] : [lineKey(path, 'LEFT', l.old)]),
  ]
}

export function threadIndex(threads: readonly ReviewThread[]): Map<string, ReviewThread[]> {
  const out = new Map<string, ReviewThread[]>()
  for (const t of threads) {
    if (t.line === null) continue
    const k = lineKey(t.path, t.side, t.line)
    out.set(k, [...(out.get(k) ?? []), t])
  }
  return out
}

/** The threads on these lines (a unified line, or a split row's one or two lines), once each. */
export function threadsOn<T>(
  index: ReadonlyMap<string, T[]>,
  path: string,
  lines: readonly DiffLine[],
): T[] {
  return [...new Set(lines.flatMap((l) => keysOf(path, l).flatMap((k) => index.get(k) ?? [])))]
}

/** A file's threads whose line is not in the diff shown (outdated far away, or cut): listed above it. */
export function unplacedThreads(
  threads: readonly ReviewThread[],
  path: string,
  hunks: readonly Hunk[],
): ReviewThread[] {
  const shown = new Set(hunks.flatMap((h) => h.lines.flatMap((l) => keysOf(path, l))))
  return threads.filter(
    (t) => t.path === path && (t.line === null || !shown.has(lineKey(t.path, t.side, t.line))),
  )
}

/** The line a new thread goes on: added and unchanged lines on the new side, removed on the old. */
export function placeOf(l: DiffLine): { side: DiffSide; line: number } | null {
  if (l.kind === 'del') return l.old === null ? null : { side: 'LEFT', line: l.old }
  return l.new === null ? null : { side: 'RIGHT', line: l.new }
}

/** How a private ask made on a line names it; `asksOn` finds its thread there again. */
export function anchorText(path: string, side: DiffSide, line: number): string {
  return `(On ${path} line ${String(line)}${side === 'LEFT' ? ', old side' : ''})`
}

const ANCHOR = /^\(On (.+) line (\d+)(, old side)?\)/

/** The assistant threads asked from a line, by the line key their first message names. */
export function asksIndex(threads: readonly AstraThread[]): Map<string, AstraThread[]> {
  const out = new Map<string, AstraThread[]>()
  for (const t of threads) {
    const m = ANCHOR.exec(t.root.text)
    if (!m) continue
    const k = lineKey(m[1]!, m[3] ? 'LEFT' : 'RIGHT', Number(m[2]))
    out.set(k, [...(out.get(k) ?? []), t])
  }
  return out
}
