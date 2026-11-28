import { describe, expect, it } from 'vitest'
import type { ReviewComment } from '@evaos/contract'
import { parseDiff } from '@relay/protocol/unified-diff'
import type { AstraThread } from './astra-timeline'
import {
  anchorText,
  asksIndex,
  placeOf,
  threadIndex,
  threadsOf,
  threadsOn,
  unplacedThreads,
} from './review-threads'

const c = (id: number, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  inReplyTo: null,
  path: 'a.ts',
  line: 2,
  originalLine: 2,
  side: 'RIGHT',
  outdated: false,
  author: 'todd',
  body: `c${id}`,
  at: id,
  ...extra,
})

const [FILE] = parseDiff(
  [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '',
  ].join('\n'),
)
const LINES = FILE!.hunks[0]!.lines

describe('review threads', () => {
  it('puts replies under their root and keeps an orphan reply as a root', () => {
    const t = threadsOf([c(3, { inReplyTo: 1 }), c(1), c(2, { inReplyTo: 99 })])
    expect(t.map((x) => [x.root.id, x.replies.map((r) => r.id)])).toEqual([
      [1, [3]],
      [2, []],
    ])
  })

  it('finds threads on their line by side, outdated ones on their original line', () => {
    const threads = threadsOf([
      c(1),
      c(2, { side: 'LEFT', line: 2 }),
      c(3, { outdated: true, line: null, originalLine: 3 }),
      c(4, { outdated: true, line: null, originalLine: 40 }),
    ])
    const index = threadIndex(threads)
    const [one, del, add, three] = LINES
    expect(threadsOn(index, 'a.ts', [add!]).map((t) => t.root.id)).toEqual([1])
    expect(threadsOn(index, 'a.ts', [del!]).map((t) => t.root.id)).toEqual([2])
    expect(threadsOn(index, 'a.ts', [three!]).map((t) => t.root.id)).toEqual([3])
    expect(threadsOn(index, 'a.ts', [one!])).toEqual([])
    expect(threadsOn(index, 'b.ts', [add!])).toEqual([])
    expect(unplacedThreads(threads, 'a.ts', FILE!.hunks).map((t) => t.root.id)).toEqual([4])
  })

  it('places a new thread on the new side, a removed line on the old side', () => {
    expect(placeOf(LINES[1]!)).toEqual({ side: 'LEFT', line: 2 })
    expect(placeOf(LINES[2]!)).toEqual({ side: 'RIGHT', line: 2 })
    expect(placeOf(LINES[0]!)).toEqual({ side: 'RIGHT', line: 1 })
  })

  it('finds a private ask again on the line it names', () => {
    const ask = (text: string): AstraThread => ({
      id: text,
      root: { id: text, role: 'user', text, streaming: false },
      replies: [],
    })
    const index = asksIndex([
      ask(`${anchorText('a.ts', 'RIGHT', 2)} @Astra why?`),
      ask(`${anchorText('a.ts', 'LEFT', 2)} @Astra and this?`),
      ask('@Astra general'),
    ])
    expect(threadsOn(index, 'a.ts', [LINES[2]!]).map((t) => t.id)).toEqual([
      '(On a.ts line 2) @Astra why?',
    ])
    expect(threadsOn(index, 'a.ts', [LINES[1]!])).toHaveLength(1)
  })
})
