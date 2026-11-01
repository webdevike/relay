import { describe, expect, it } from 'vitest'
import type { AstraTurn } from '@evaos/contract'
import { astraBlocks, mergeTimeline, type TimelineEntry } from './astra-timeline'

const turn = (id: string, role: AstraTurn['role'], at?: number): AstraTurn => ({
  id,
  role,
  text: id,
  streaming: false,
  ...(at === undefined ? {} : { at }),
})

const ids = (rows: Array<TimelineEntry<{ id: string; at: number }>>): string[] =>
  rows.map((r) => (r.kind === 'comment' ? r.item.id : r.block.id))

describe('astra timeline', () => {
  it('makes each ask a card and each run of answers and tools one reply', () => {
    const blocks = astraBlocks([
      turn('u1', 'user', 10),
      turn('x1', 'tool', 10),
      turn('a1', 'assistant', 12),
      turn('a2', 'assistant', 13),
      turn('u2', 'user', 20),
      turn('a3', 'assistant'),
    ])
    expect(blocks.map((b) => [b.kind, b.id, b.at])).toEqual([
      ['ask', 'u1', 10],
      ['reply', 'x1', 10],
      ['ask', 'u2', 20],
      ['reply', 'a3', undefined],
    ])
    expect(blocks[1]!.kind === 'reply' && blocks[1]!.turns.map((t) => t.id)).toEqual([
      'x1',
      'a1',
      'a2',
    ])
  })

  it('gives a pending session a reply card after its last ask', () => {
    const blocks = astraBlocks([turn('u1', 'user', 10)], true)
    expect(blocks.map((b) => [b.kind, b.id, b.at])).toEqual([
      ['ask', 'u1', 10],
      ['reply', 'u1-pending', 10],
    ])
    expect(astraBlocks([turn('u1', 'user', 10), turn('a1', 'assistant', 11)], true)).toHaveLength(2)
    expect(astraBlocks([], false)).toEqual([])
  })

  it('interleaves comments and Astra by time, comments first on a tie, untimed last', () => {
    const comments = [
      { id: 'c1', at: 5 },
      { id: 'c2', at: 15 },
      { id: 'c3', at: 30 },
    ]
    const blocks = astraBlocks([
      turn('u1', 'user', 10),
      turn('a1', 'assistant', 15),
      turn('u2', 'user'),
      turn('a2', 'assistant'),
    ])
    expect(ids(mergeTimeline(comments, (c) => c.at, blocks))).toEqual([
      'c1',
      'u1',
      'c2',
      'a1',
      'c3',
      'u2',
      'a2',
    ])
  })
})
