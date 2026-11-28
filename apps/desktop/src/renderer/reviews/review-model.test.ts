import { describe, expect, it } from 'vitest'
import type { ReviewQueue, ReviewRow } from '@evaos/contract'
import { mentionsAstra, nextAfter, queueGroups } from './review-model'

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
