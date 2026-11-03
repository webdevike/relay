import { describe, expect, it } from 'vitest'
import type { ReviewQueue, ReviewRow } from '@evaos/contract'
import { parseDiff, parseHunks, splitRows } from './diff'
import { mentionsAstra, nextAfter, queueGroups } from './review-model'

const DIFF = `diff --git a/README.md b/README.md
index 1..2 100644
--- a/README.md
+++ b/README.md
@@ -4,3 +4,4 @@ intro
 | a |
-| b |
+| b2 |
+| c |
 | d |
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
`

describe('diff', () => {
  it('parses files, numbers lines and counts the unchanged lines before a hunk', () => {
    const files = parseDiff(DIFF)
    expect(files.map((f) => f.path)).toEqual(['README.md', 'new.ts'])
    const h = files[0]!.hunks[0]!
    expect(h.skipped).toBe(3)
    expect(h.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['ctx', 4, 4],
      ['del', 5, null],
      ['add', null, 5],
      ['add', null, 6],
      ['ctx', 6, 7],
    ])
    expect(files[1]!.hunks[0]!.lines).toHaveLength(2)
  })

  it('pairs a deletion run with the additions after it in split view', () => {
    const rows = splitRows(parseHunks('@@ -1,2 +1,3 @@\n a\n-b\n+b2\n+c').at(0)!.lines)
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'b2'],
      [null, 'c'],
    ])
  })
})

const row = (n: number, updatedAt = 10): ReviewRow => ({
  repo: 'o/r',
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  author: 'a',
  draft: false,
  updatedAt,
})

describe('queue', () => {
  const q: ReviewQueue = {
    needs: [row(1), row(2)],
    reviewing: [row(3)],
    completed: [row(4)],
    completedTotal: 40,
    created: [],
    done: { 'https://github.com/o/r/pull/2': 10 },
    fetchedAt: 0,
  }

  it('hides Done rows until they change and counts every completed review', () => {
    const g = queueGroups(q, 'for-me')
    expect(g.map((x) => [x.id, x.rows.map((r) => r.number), x.count])).toEqual([
      ['needs', [1], 1],
      ['reviewing', [3], 1],
      ['completed', [4], 40],
    ])
    const changed = { ...q, needs: [row(1), row(2, 11)] }
    expect(queueGroups(changed, 'for-me')[0]!.rows.map((r) => r.number)).toEqual([1, 2])
  })

  it('moves to the next open row after Done, never into Completed', () => {
    const g = queueGroups(q, 'for-me')
    expect(nextAfter(g, 'o/r#1')?.number).toBe(3)
    expect(nextAfter(g, 'o/r#3')?.number).toBe(1)
  })

  it('treats an @Astra mention as private', () => {
    expect(mentionsAstra('@Astra can this pass 1000?')).toBe(true)
    expect(mentionsAstra('ping @astra')).toBe(true)
    expect(mentionsAstra('email me@astra.dev')).toBe(false)
  })
})
