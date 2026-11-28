// A v2 Guide section's code: only the hunks it cites, per file, out of the PR's parsed diff, and its
// callouts keyed by the diff line they sit under (one line object serves both split sides).
import type { ReviewGuideHunk } from '@evaos/contract'
import { hunkId, lineOn, type GuideCallout } from '@relay/protocol/review-guide'
import type { DiffFile, DiffLine, Hunk, SplitRow } from '@relay/protocol/unified-diff'

export interface SectionFile {
  path: string
  /** The cited hunks in file order, `skipped` counted against the previous shown hunk. */
  hunks: Hunk[]
  /** Callouts by the line they annotate. */
  callouts: Map<DiffLine, GuideCallout[]>
}

const OLD_START = /^@@ -(\d+)(?:,(\d+))?/

/** First old line and how many old lines a hunk header covers (`-5,0` is an insertion after 5). */
function oldSpan(hunk: Hunk): { start: number; count: number } {
  const m = OLD_START.exec(hunk.header)
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

function addCallouts(map: Map<DiffLine, GuideCallout[]>, hunk: Hunk, ref: ReviewGuideHunk): void {
  for (const c of ref.callouts) {
    const line = hunk.lines.find((l) => lineOn(l, c.side) === c.line)
    if (line) map.set(line, [...(map.get(line) ?? []), c])
  }
}

/** A section's cited hunks grouped by file, in the order the section first cites each file. */
export function sectionFiles(
  diffs: ReadonlyMap<string, DiffFile>,
  refs: readonly ReviewGuideHunk[],
): SectionFile[] {
  const byPath = new Map<string, { picked: Set<number>; callouts: Map<DiffLine, GuideCallout[]> }>()
  for (const ref of refs) {
    const file = diffs.get(ref.path)
    const at = file?.hunks.findIndex((h) => hunkId(ref.path, h) === ref.id) ?? -1
    if (!file || at < 0) continue
    const entry = byPath.get(ref.path) ?? { picked: new Set<number>(), callouts: new Map() }
    entry.picked.add(at)
    addCallouts(entry.callouts, file.hunks[at]!, ref)
    byPath.set(ref.path, entry)
  }
  return [...byPath].map(([path, { picked, callouts }]) => {
    const all = diffs.get(path)!.hunks
    return { path, hunks: withSkipped(all.filter((_, i) => picked.has(i))), callouts }
  })
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
