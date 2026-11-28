// A v2 Guide section's code: only the lines each citation accepts (its `start..end` on its side,
// the other side's half of a change there, and the lines its callouts sit on), per file, out of the
// PR's parsed diff (the same base...head snapshot the Guide was written from), and its callouts
// keyed by the diff line they sit under (one line object serves both split sides). A citation the
// loaded diff doesn't have is reported, never dropped silently or widened to its whole hunk.
import type { ReviewGuideHunk } from '@evaos/contract'
import { hunkId, lineOn, type GuideCallout, type GuideSide } from '@relay/protocol/review-guide'
import type { DiffFile, DiffLine, Hunk, SplitRow } from '@relay/protocol/unified-diff'

export interface SectionFile {
  path: string
  /** The cited ranges in file order, `skipped` counted against the previous shown one. */
  hunks: Hunk[]
  /** Callouts by the line they annotate. */
  callouts: Map<DiffLine, GuideCallout[]>
}

export interface SectionCode {
  files: SectionFile[]
  /** Citations the loaded diff has no lines for (it was cut for size, or the PR moved). */
  missing: ReviewGuideHunk[]
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** First old line and how many old lines a hunk header covers (`-5,0` is an insertion after 5). */
function oldSpan(hunk: Hunk): { start: number; count: number } {
  const m = HEADER.exec(hunk.header)
  return { start: Number(m?.[1] ?? 0), count: Number(m?.[2] ?? 1) }
}

/** `hunks` (in file order) with each `skipped` recounted as if only they were in the file. */
export function withSkipped(hunks: readonly Hunk[]): Hunk[] {
  let lastOld = 0
  return hunks.map((h) => {
    const { start, count } = oldSpan(h)
    const skipped = Math.max(0, start - 1 - lastOld)
    lastOld = count === 0 ? start : start + count - 1
    return { ...h, skipped }
  })
}

/** Where `lines` (a run of `hunk` from index `from`) start and how many lines they cover on `side`. */
function span(hunk: Hunk, lines: readonly DiffLine[], from: number, side: GuideSide) {
  const nums = lines.map((l) => lineOn(l, side)).filter((n): n is number => n !== null)
  if (nums.length > 0) return { start: nums[0]!, count: nums.length }
  // No line on this side: the run sits after the side's last line before it (unified diff's `N,0`).
  const before = hunk.lines
    .slice(0, from)
    .map((l) => lineOn(l, side))
    .filter((n): n is number => n !== null)
  const m = HEADER.exec(hunk.header)
  const first = Number((side === 'old' ? m?.[1] : m?.[3]) ?? 1)
  return { start: before.at(-1) ?? Math.max(0, first - 1), count: 0 }
}

/** The run of `hunk` from index `from` as a hunk of its own, with its header recounted. */
function subHunk(hunk: Hunk, from: number, to: number): Hunk {
  const lines = hunk.lines.slice(from, to + 1)
  const o = span(hunk, lines, from, 'old')
  const n = span(hunk, lines, from, 'new')
  const tail = HEADER.exec(hunk.header)?.[5] ?? ''
  return { header: `@@ -${o.start},${o.count} +${n.start},${n.count} @@${tail}`, skipped: 0, lines }
}

/**
 * The lines a citation accepts, as a hunk: those of its side in `start..end`, the other side's half
 * of a change at either edge (removed lines just before new ones, added lines just after old ones)
 * and every line a callout sits on. Null when none of the hunk's lines is cited.
 */
export function citedHunk(hunk: Hunk, ref: ReviewGuideHunk): Hunk | null {
  const cited = (l: DiffLine): boolean => {
    const n = lineOn(l, ref.side)
    const inRange = n !== null && n >= ref.start && n <= ref.end
    return inRange || ref.callouts.some((c) => lineOn(l, c.side) === c.line)
  }
  let from = hunk.lines.findIndex(cited)
  if (from < 0) return null
  let to = hunk.lines.findLastIndex(cited)
  const other = (i: number): boolean =>
    hunk.lines[i] !== undefined && lineOn(hunk.lines[i], ref.side) === null
  if (ref.side === 'new') while (other(from - 1)) from -= 1
  else while (other(to + 1)) to += 1
  return subHunk(hunk, from, to)
}

function addCallouts(map: Map<DiffLine, GuideCallout[]>, hunk: Hunk, ref: ReviewGuideHunk): void {
  for (const c of ref.callouts) {
    const line = hunk.lines.find((l) => lineOn(l, c.side) === c.line)
    if (line) map.set(line, [...(map.get(line) ?? []), c])
  }
}

interface Picked {
  ranges: Array<{ at: number; hunk: Hunk }>
  callouts: Map<DiffLine, GuideCallout[]>
}

/** A section's cited ranges grouped by file, in the order the section first cites each file, and the citations the diff lacks. */
export function sectionCode(
  diffs: ReadonlyMap<string, DiffFile>,
  refs: readonly ReviewGuideHunk[],
): SectionCode {
  const byPath = new Map<string, Picked>()
  const missing: ReviewGuideHunk[] = []
  for (const ref of refs) {
    const file = diffs.get(ref.path)
    const at = file?.hunks.findIndex((h) => hunkId(ref.path, h) === ref.id) ?? -1
    const hunk = at < 0 ? null : citedHunk(file!.hunks[at]!, ref)
    if (!hunk) {
      missing.push(ref)
      continue
    }
    const entry: Picked = byPath.get(ref.path) ?? { ranges: [], callouts: new Map() }
    entry.ranges.push({ at, hunk })
    addCallouts(entry.callouts, file!.hunks[at]!, ref)
    byPath.set(ref.path, entry)
  }
  const files = [...byPath].map(([path, { ranges, callouts }]) => ({
    path,
    hunks: withSkipped([...ranges].sort((a, b) => a.at - b.at).map((r) => r.hunk)),
    callouts,
  }))
  return { files, missing }
}

/** The lines a split row shows (a context line is one object on both sides). */
export function rowLines(row: SplitRow): DiffLine[] {
  const lines = [row.left, row.right].filter((l): l is DiffLine => l !== null)
  return lines.length === 2 && lines[0] === lines[1] ? [lines[0]!] : lines
}

/** The callouts under a unified line or a split row's lines. */
export function calloutsFor(
  map: ReadonlyMap<DiffLine, GuideCallout[]>,
  lines: readonly DiffLine[],
): GuideCallout[] {
  return lines.flatMap((l) => map.get(l) ?? [])
}
