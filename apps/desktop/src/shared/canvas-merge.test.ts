import { describe, expect, it } from 'vitest'
import type { CanvasBoard, CanvasNode } from '@evaos/contract'
import { changedIds, mergeBoards } from './canvas-merge'

const card = (id: string, x: number, title = id): CanvasNode => ({
  id,
  type: 'note',
  x,
  y: 0,
  data: { title },
})
const board = (nodes: CanvasNode[], extra: Partial<CanvasBoard> = {}): CanvasBoard => ({
  version: 1,
  title: 'B',
  nodes,
  edges: [],
  ...extra,
})

describe('mergeBoards', () => {
  it("keeps Isaac's drag and the agent's new card when both happened since his last read", () => {
    const base = board([card('a', 0), card('b', 100)])
    const ours = board([card('a', 40), card('b', 100)])
    const theirs = board([card('a', 0), card('b', 100), card('agent-1', 300, 'Agent')])
    expect(mergeBoards(base, ours, theirs).nodes).toEqual([
      card('a', 40),
      card('b', 100),
      card('agent-1', 300, 'Agent'),
    ])
  })

  it("keeps the agent's edit of a card Isaac did not touch, and his own delete of another", () => {
    const base = board([card('a', 0), card('b', 100)])
    const ours = board([card('b', 100)])
    const theirs = board([card('a', 0), card('b', 100, 'Renamed by agent')])
    expect(mergeBoards(base, ours, theirs).nodes).toEqual([card('b', 100, 'Renamed by agent')])
  })

  it("keeps Isaac's new card and his viewport, and the file's title change", () => {
    const base = board([card('a', 0)], { viewport: { x: 0, y: 0, zoom: 1 } })
    const ours = board([card('a', 0), card('note-2', 50)], { viewport: { x: 9, y: 9, zoom: 2 } })
    const theirs = board([card('a', 0)], { title: 'New', viewport: { x: 0, y: 0, zoom: 1 } })
    const m = mergeBoards(base, ours, theirs)
    expect(m.nodes.map((n) => n.id)).toEqual(['a', 'note-2'])
    expect(m.viewport).toEqual({ x: 9, y: 9, zoom: 2 })
    expect(m.title).toBe('New')
  })

  it('treats a card with the same fields in another key order as unchanged', () => {
    const base = board([{ id: 'a', type: 'note', x: 0, y: 0 }])
    const ours = board([{ y: 0, x: 0, type: 'note', id: 'a' }])
    const theirs = board([{ id: 'a', type: 'note', x: 70, y: 0 }])
    expect(mergeBoards(base, ours, theirs).nodes[0]).toMatchObject({ x: 70 })
  })
})

describe('changedIds', () => {
  it('names the cards an undo step changes, added and removed ones too', () => {
    expect([...changedIds([card('a', 0), card('b', 0)], [card('a', 5), card('c', 0)])]).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})
