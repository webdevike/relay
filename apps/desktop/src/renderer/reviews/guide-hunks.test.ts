import { describe, expect, it } from 'vitest'
import type { ReviewGuideHunk } from '@evaos/contract'
import { guideRequest, parseGuide } from '@relay/protocol/review-guide'
import { parseDiff, splitRows, type Hunk } from '@relay/protocol/unified-diff'
import fixture from '@relay/protocol/fixtures/review-guide.json'
import { calloutsFor, citedHunk, rowLines, sectionCode, withSkipped } from './guide-hunks'

const diffs = new Map(parseDiff(fixture.input.diff).map((f) => [f.path, f]))
const refs = (i: number): ReviewGuideHunk[] =>
  fixture.expected.sections[i]!.hunks as ReviewGuideHunk[]
const ref = (id: string, path: string, over: Partial<ReviewGuideHunk> = {}): ReviewGuideHunk => ({
  id,
  path,
  side: 'new',
  start: 1,
  end: 99_999,
  callouts: [],
  ...over,
})
const policy = diffs.get('src/policy.ts')!

describe('guide hunks', () => {
  it("keeps only a section's cited hunks, grouped by file in citing order", () => {
    const { files, missing } = sectionCode(diffs, refs(2))
    expect(files.map((f) => [f.path, f.hunks.map((h) => h.header)])).toEqual([
      ['src/old.ts', ['@@ -1,3 +0,0 @@']],
      ['src/new-name.ts', ['@@ -1,1 +1,1 @@']],
    ])
    expect(missing).toEqual([])
    const one = sectionCode(diffs, [ref('src/policy.ts#20,21', 'src/policy.ts')]).files
    expect(one[0]!.hunks).toHaveLength(1)
    expect(one[0]!.hunks[0]!.lines).toEqual(policy.hunks[1]!.lines)
  })

  it('shows only the accepted range, the other half of a change at its edge, and callout lines', () => {
    const hunk = policy.hunks[0]!
    const lines = (h: Hunk | null) => h!.lines.map((l) => [l.kind, l.old, l.new])
    // New 4..5: the two added lines, and the two removed lines they replace.
    const changed = citedHunk(hunk, ref('src/policy.ts#3,3', 'src/policy.ts', { start: 4, end: 5 }))
    expect(lines(changed)).toEqual([
      ['del', 4, null],
      ['del', 5, null],
      ['add', null, 4],
      ['add', null, 5],
    ])
    expect(changed!.header).toBe('@@ -4,2 +4,2 @@ import { clock } from "./clock";')
    // A callout outside the range widens it to its own line, no further.
    const noted = citedHunk(
      hunk,
      ref('src/policy.ts#3,3', 'src/policy.ts', {
        start: 4,
        end: 4,
        callouts: [{ line: 7, side: 'new', note: 'n' }],
      }),
    )
    expect(lines(noted).at(-1)).toEqual(['ctx', 6, 7])
    expect(lines(noted)[0]).toEqual(['del', 4, null])
    // Old side: the removed line and the added lines that replace it after.
    const old = citedHunk(
      hunk,
      ref('src/policy.ts#3,3', 'src/policy.ts', { side: 'old', start: 5, end: 5 }),
    )
    expect(lines(old)).toEqual([
      ['del', 5, null],
      ['add', null, 4],
      ['add', null, 5],
      ['add', null, 6],
    ])
    expect(old!.header).toBe('@@ -5,1 +4,3 @@ import { clock } from "./clock";')
    // A deletion's single old line has no new side at all.
    const gone = citedHunk(
      diffs.get('src/old.ts')!.hunks[0]!,
      ref('src/old.ts#1,0', 'src/old.ts', { side: 'old', start: 2, end: 2 }),
    )
    expect(gone!.header).toBe('@@ -2,1 +0,0 @@')
  })

  it('reports citations the loaded diff has no lines for instead of dropping them', () => {
    const outside = ref('src/policy.ts#3,3', 'src/policy.ts', { start: 90, end: 99 })
    const unknown = ref('src/policy.ts#99,99', 'src/policy.ts')
    const gone = ref('x#1,1', 'x')
    const { files, missing } = sectionCode(diffs, [
      outside,
      unknown,
      gone,
      ref('src/route.ts#10,10', 'src/route.ts'),
    ])
    expect(files.map((f) => f.path)).toEqual(['src/route.ts'])
    expect(missing).toEqual([outside, unknown, gone])
  })

  it('renders a valid late citation after a large early file from the same snapshot', () => {
    const early = Array.from({ length: 30_000 }, (_, i) => `+const v${i} = ${i};`).join('\n')
    const diff = `diff --git a/early.ts b/early.ts\n--- a/early.ts\n+++ b/early.ts\n@@ -1,1 +1,30000 @@\n-x\n${early}\ndiff --git a/late.ts b/late.ts\n--- a/late.ts\n+++ b/late.ts\n@@ -40,1 +40,3 @@\n-a\n+b\n+c\n+d\n`
    expect(diff.length).toBeGreaterThan(300_000)
    const req = guideRequest({ title: 't', body: '', files: [], diff })!
    const section = (title: string, hunks: object[]) => ({
      title,
      explanation: 'e',
      check: ['c'],
      hunks,
    })
    const answer = JSON.stringify({
      overview: 'o',
      risk: 'low',
      riskWhy: 'r',
      checklist: ['k'],
      sections: [
        section('Early', [{ id: 'early.ts#1,1', side: 'new', start: 2, end: 3 }]),
        section('Late', [{ id: 'late.ts#40,40', side: 'new', start: 41, end: 42 }]),
      ],
    })
    const guide = parseGuide(answer, req.sent, ['early.ts', 'late.ts'])!
    const snapshot = new Map(parseDiff(diff).map((f) => [f.path, f]))
    const late = sectionCode(snapshot, guide.sections[1]!.hunks)
    expect(late.missing).toEqual([])
    expect(late.files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['c', 'd'])
    const first = sectionCode(snapshot, guide.sections[0]!.hunks).files[0]!.hunks[0]!
    expect(first.lines.map((l) => l.new)).toEqual([2, 3])
  })

  it('recounts skipped lines for the subset and keeps file order', () => {
    expect(policy.hunks.map((h) => h.skipped)).toEqual([2, 13])
    const second = sectionCode(diffs, [ref('src/policy.ts#20,21', 'src/policy.ts')]).files[0]!
    expect(second.hunks.map((h) => h.skipped)).toEqual([19])
    const both = sectionCode(diffs, [
      ref('src/policy.ts#20,21', 'src/policy.ts'),
      ref('src/policy.ts#3,3', 'src/policy.ts'),
    ]).files[0]!
    expect(both.hunks.map((h) => [h.header.slice(0, 12), h.skipped])).toEqual([
      ['@@ -3,4 +3,5', 2],
      ['@@ -20,3 +21', 13],
    ])
    expect(withSkipped([diffs.get('tests/policy.test.ts')!.hunks[0]!])[0]!.skipped).toBe(0)
  })

  it('puts callouts under their line in unified and split', () => {
    const [file] = sectionCode(diffs, refs(0)).files
    const hunk = file!.hunks[0]!
    // Unified: each line on its own.
    const unified = hunk.lines.map((l) => calloutsFor(file!.callouts, [l]).map((c) => c.note))
    const at = (old: number | null, nu: number | null): string[] =>
      unified[hunk.lines.findIndex((l) => l.old === old && l.new === nu)]!
    expect(at(5, null)).toEqual(['The old code compared milliseconds to minutes'])
    expect(at(null, 5)).toEqual(['Minutes, not milliseconds'])
    expect(unified.flat()).toHaveLength(2)
    // Split: old 5 and new 5 sit on the same row, so both notes go under it, once each.
    const rows = splitRows(hunk.lines)
    const split = rows.map((r) => calloutsFor(file!.callouts, rowLines(r)).map((c) => c.note))
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
