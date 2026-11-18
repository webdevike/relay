import { describe, expect, it } from 'vitest'
import type { CanvasRun } from '@evaos/contract'
import { HOLD_REFRESH_MS, cardsIsaacChanges, dueHolds, shownRun } from './runs-store'

function run(slug: string, status: CanvasRun['status']): CanvasRun {
  return {
    id: 'penny',
    name: 'Penny',
    color: '#86efac',
    status,
    caption: '',
    background: false,
    ask: null,
    since: 1,
    ended: null,
    slug,
    board: 'Plan',
    page: 'page-1',
    workspace: 'page:agent:penny',
  }
}

describe('cardsIsaacChanges', () => {
  it('holds the cards he drags or resizes, never ones he only selects or the layout sizes', () => {
    expect(
      cardsIsaacChanges([
        { type: 'select', id: 'picked', selected: true },
        { type: 'dimensions', id: 'measured', dimensions: { width: 10, height: 10 } },
        { type: 'position', id: 'dragged', position: { x: 1, y: 2 }, dragging: true },
        {
          type: 'dimensions',
          id: 'resized',
          dimensions: { width: 10, height: 10 },
          resizing: true,
          setAttributes: true,
        },
      ]),
    ).toEqual(['dragged', 'resized'])
  })
})

describe('dueHolds', () => {
  it('sends a card once per refresh while he keeps changing it, and again after', () => {
    const sent = new Map<string, number>()
    expect(dueHolds(sent, ['a', 'a', 'b'], 0)).toEqual(['a', 'b'])
    expect(dueHolds(sent, ['a'], HOLD_REFRESH_MS - 1)).toEqual([])
    expect(dueHolds(sent, ['a', 'c'], HOLD_REFRESH_MS)).toEqual(['a', 'c'])
  })
})

describe('shownRun', () => {
  it("is the board's run that isn't idle", () => {
    const runs = [run('ideas', 'working'), run('plan', 'idle')]
    expect(shownRun(runs, 'plan')).toBeNull()
    expect(shownRun(runs, 'ideas')?.slug).toBe('ideas')
    expect(shownRun(runs, null)).toBeNull()
  })
})
