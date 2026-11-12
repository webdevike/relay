import { describe, expect, it } from 'vitest'
import { alignNodes, distributeNodes, routeCrossesCards } from './index'
import type { Box } from './types'

const boxes = (entries: Record<string, Box>) => new Map(Object.entries(entries))

describe('routeCrossesCards', () => {
  const card = { x: 100, y: 100, w: 100, h: 50 }

  it('counts a segment through a card', () => {
    expect(
      routeCrossesCards(
        [
          { x: 50, y: 120 },
          { x: 250, y: 120 },
        ],
        [card],
      ),
    ).toBe(true)
    expect(
      routeCrossesCards(
        [
          { x: 150, y: 0 },
          { x: 150, y: 300 },
        ],
        [card],
      ),
    ).toBe(true)
  })

  it('counts a bend inside a card', () => {
    expect(
      routeCrossesCards(
        [
          { x: 0, y: 125 },
          { x: 150, y: 125 },
          { x: 150, y: 0 },
        ],
        [card],
      ),
    ).toBe(true)
  })

  it('ignores lines along a border, ending on it, or passing by', () => {
    expect(
      routeCrossesCards(
        [
          { x: 50, y: 100 },
          { x: 250, y: 100 },
        ],
        [card],
      ),
    ).toBe(false)
    expect(
      routeCrossesCards(
        [
          { x: 0, y: 125 },
          { x: 100, y: 125 },
        ],
        [card],
      ),
    ).toBe(false)
    expect(
      routeCrossesCards(
        [
          { x: 0, y: 160 },
          { x: 300, y: 160 },
        ],
        [card],
      ),
    ).toBe(false)
  })

  it('shrinks cards by pad', () => {
    const grazing = [
      { x: 50, y: 103 },
      { x: 250, y: 103 },
    ]
    expect(routeCrossesCards(grazing, [card])).toBe(true)
    expect(routeCrossesCards(grazing, [card], 4)).toBe(false)
  })
})

describe('alignNodes', () => {
  const b = boxes({
    a: { x: 10, y: 0, w: 100, h: 40 },
    b: { x: 40, y: 100, w: 60, h: 80 },
    c: { x: 0, y: 200, w: 200, h: 20 },
  })

  it('aligns left, right and centers on the joint bounds', () => {
    expect(alignNodes(b, ['a', 'b', 'c'], 'left')).toEqual(
      new Map([
        ['a', { x: 0, y: 0 }],
        ['b', { x: 0, y: 100 }],
      ]),
    )
    expect(alignNodes(b, ['a', 'b', 'c'], 'right')).toEqual(
      new Map([
        ['a', { x: 100, y: 0 }],
        ['b', { x: 140, y: 100 }],
      ]),
    )
    expect(alignNodes(b, ['a', 'b', 'c'], 'center')).toEqual(
      new Map([
        ['a', { x: 50, y: 0 }],
        ['b', { x: 70, y: 100 }],
      ]),
    )
  })

  it('aligns top, bottom and middles', () => {
    expect(alignNodes(b, ['a', 'b'], 'top')).toEqual(new Map([['b', { x: 40, y: 0 }]]))
    expect(alignNodes(b, ['a', 'b'], 'bottom')).toEqual(new Map([['a', { x: 10, y: 140 }]]))
    expect(alignNodes(b, ['a', 'b'], 'middle')).toEqual(
      new Map([
        ['a', { x: 10, y: 70 }],
        ['b', { x: 40, y: 50 }],
      ]),
    )
  })

  it('needs two known cards', () => {
    expect(alignNodes(b, ['a'], 'left').size).toBe(0)
    expect(alignNodes(b, ['a', 'ghost'], 'left').size).toBe(0)
  })
})

describe('distributeNodes', () => {
  const b = boxes({
    a: { x: 0, y: 0, w: 100, h: 40 },
    c: { x: 500, y: 10, w: 100, h: 40 },
    b: { x: 130, y: 5, w: 50, h: 40 },
    d: { x: 300, y: 0, w: 50, h: 40 },
  })

  it('keeps the outermost and evenly gaps the rest, in order along the axis', () => {
    // span 600, widths 300, three gaps of 100
    expect(distributeNodes(b, ['c', 'a', 'd', 'b'], 'horizontal')).toEqual(
      new Map([
        ['b', { x: 200, y: 5 }],
        ['d', { x: 350, y: 0 }],
      ]),
    )
  })

  it('lines up from the first with a fixed gap', () => {
    expect(distributeNodes(b, ['a', 'b', 'c'], 'horizontal', 20)).toEqual(
      new Map([
        ['b', { x: 120, y: 5 }],
        ['c', { x: 190, y: 10 }],
      ]),
    )
  })

  it('works vertically', () => {
    const v = boxes({
      a: { x: 0, y: 0, w: 10, h: 10 },
      b: { x: 0, y: 15, w: 10, h: 30 },
      c: { x: 0, y: 100, w: 10, h: 10 },
    })
    expect(distributeNodes(v, ['a', 'b', 'c'], 'vertical')).toEqual(
      new Map([['b', { x: 0, y: 40 }]]),
    )
  })

  it('leaves fewer than three alone without a gap', () => {
    expect(distributeNodes(b, ['a', 'c'], 'horizontal').size).toBe(0)
  })
})
