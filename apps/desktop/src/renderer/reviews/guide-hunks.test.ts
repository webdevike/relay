import { describe, expect, it } from 'vitest'
import type { ReviewGuideHunk } from '@evaos/contract'
import { parseDiff, splitRows } from '@relay/protocol/unified-diff'
import fixture from '@relay/protocol/fixtures/review-guide.json'
import { calloutsFor, rowLines, sectionFiles, withSkipped } from './guide-hunks'

const diffs = new Map(parseDiff(fixture.input.diff).map((f) => [f.path, f]))
const refs = (i: number): ReviewGuideHunk[] =>
  fixture.expected.sections[i]!.hunks as ReviewGuideHunk[]
const ref = (
  id: string,
  path: string,
  callouts: ReviewGuideHunk['callouts'] = [],
): ReviewGuideHunk => ({
  id,
  path,
  side: 'new',
  start: 0,
  end: 0,
  callouts,
})

describe('guide hunks', () => {
  it("keeps only a section's cited hunks, grouped by file in citing order", () => {
    const files = sectionFiles(diffs, refs(2))
    expect(files.map((f) => [f.path, f.hunks.map((h) => h.header)])).toEqual([
      ['src/old.ts', ['@@ -1,3 +0,0 @@']],
      ['src/new-name.ts', ['@@ -1,2 +1,2 @@']],
    ])
    const one = sectionFiles(diffs, [ref('src/policy.ts#20,21', 'src/policy.ts')])
    expect(one[0]!.hunks).toHaveLength(1)
    expect(one[0]!.hunks[0]!.lines).toBe(diffs.get('src/policy.ts')!.hunks[1]!.lines)
    expect(
      sectionFiles(diffs, [ref('src/policy.ts#99,99', 'src/policy.ts'), ref('x#1,1', 'x')]),
    ).toEqual([])
  })

  it('recounts skipped lines for the subset and keeps file order', () => {
    const full = diffs.get('src/policy.ts')!.hunks
    expect(full.map((h) => h.skipped)).toEqual([2, 13])
    const second = sectionFiles(diffs, [ref('src/policy.ts#20,21', 'src/policy.ts')])[0]!
    expect(second.hunks.map((h) => h.skipped)).toEqual([19])
    const both = sectionFiles(diffs, [
      ref('src/policy.ts#20,21', 'src/policy.ts'),
      ref('src/policy.ts#3,3', 'src/policy.ts'),
    ])[0]!
    expect(both.hunks.map((h) => [h.header.slice(0, 12), h.skipped])).toEqual([
      ['@@ -3,4 +3,5', 2],
      ['@@ -20,3 +21', 13],
    ])
    expect(withSkipped([diffs.get('tests/policy.test.ts')!.hunks[0]!])[0]!.skipped).toBe(0)
  })

  it('puts callouts under their line in unified and split', () => {
    const [policy] = sectionFiles(diffs, refs(0))
    const hunk = policy!.hunks[0]!
    // Unified: each line on its own.
    const unified = hunk.lines.map((l) => calloutsFor(policy!.callouts, [l]).map((c) => c.note))
    const at = (old: number | null, nu: number | null): string[] =>
      unified[hunk.lines.findIndex((l) => l.old === old && l.new === nu)]!
    expect(at(5, null)).toEqual(['The old code compared milliseconds to minutes'])
    expect(at(null, 5)).toEqual(['Minutes, not milliseconds'])
    expect(unified.flat()).toHaveLength(2)
    // Split: old 5 and new 5 sit on the same row, so both notes go under it, once each.
    const rows = splitRows(hunk.lines)
    const split = rows.map((r) => calloutsFor(policy!.callouts, rowLines(r)).map((c) => c.note))
    expect(split.flat()).toHaveLength(2)
    const row = rows.findIndex((r) => r.left?.old === 5)
    expect(rows[row]!.right?.new).toBe(5)
    expect(split[row]).toEqual([
      'The old code compared milliseconds to minutes',
      'Minutes, not milliseconds',
    ])
    // A context line is one object on both sides: its note shows once.
    const ctx = hunk.lines.find((l) => l.kind === 'ctx')!
    expect(rowLines({ left: ctx, right: ctx })).toEqual([ctx])
  })
})
