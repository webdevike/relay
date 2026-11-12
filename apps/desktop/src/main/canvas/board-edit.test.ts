import { describe, expect, it } from 'vitest'
import type { CanvasBoard, CanvasNode } from '@evaos/contract'
import {
  arrangeCards,
  boxesOf,
  grownFrame,
  layoutGraph,
  placeNew,
  typicalSize,
  withFrameChildren,
  type Box,
} from './board-edit'

const board = (nodes: CanvasNode[], edges: CanvasBoard['edges'] = []): CanvasBoard => ({
  version: 1,
  title: 'Test',
  nodes,
  edges,
})

const card = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type: 'note',
  x,
  y,
  w: 220,
  h: 120,
  ...extra,
})

/** No two boxes overlap (touching edges are fine). */
function apart(boxes: Box[]): boolean {
  return boxes.every((a, i) =>
    boxes.every(
      (b, j) =>
        i === j || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
    ),
  )
}

describe('placeNew', () => {
  it('starts at the origin and fills a row right of the last card until it is 4 cards long', () => {
    const size = { w: 220, h: 120 }
    let b = board([])
    const spots: Box[] = []
    for (let i = 0; i < 6; i++) {
      const at = placeNew(b, boxesOf(b.nodes, null), size)!
      spots.push({ ...at, ...size })
      b = board([...b.nodes, card(`c${i}`, at.x, at.y)])
    }
    expect(spots.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [300, 0],
      [600, 0],
      [900, 0],
      // The row is 4 cards long: a new row under everything, left-aligned with it.
      [0, 200],
      [300, 200],
    ])
    expect(apart(spots)).toBe(true)
  })

  it('starts a new row once the row would grow past 1500 px', () => {
    const b = board([
      card('a', 0, 0, { type: 'explainer', w: 380, h: 200 }),
      card('b', 460, 0, { type: 'explainer', w: 380, h: 200 }),
      card('c', 920, 0, { type: 'explainer', w: 380, h: 200 }),
    ])
    expect(placeNew(b, boxesOf(b.nodes, null), { w: 380, h: 200 })).toEqual({ x: 0, y: 280 })
  })

  it('puts a card after the card it follows: right of it, then under its last linked card', () => {
    const b = board([card('a', 0, 0), card('b', 300, 0)], [{ id: 'a-b', source: 'a', target: 'b' }])
    const boxes = boxesOf(b.nodes, null)
    // Right of `b` is free.
    expect(placeNew(b, boxes, { w: 220, h: 120 }, { from: 'b' })).toEqual({ x: 600, y: 0 })
    // Right of `a` is taken by its first child `b`: the next goes under `b`.
    expect(placeNew(b, boxes, { w: 220, h: 120 }, { from: 'a' })).toEqual({ x: 300, y: 160 })
  })

  it('slides a card it puts under the last linked card past anything in the way', () => {
    const b = board(
      [card('a', 0, 0), card('b', 300, 0), card('x', 300, 160)],
      [{ id: 'a-b', source: 'a', target: 'b' }],
    )
    const at = placeNew(b, boxesOf(b.nodes, null), { w: 220, h: 120 }, { from: 'a' })!
    expect(at.x).toBe(300)
    expect(apart([...boxesOf(b.nodes, null).values(), { ...at, w: 220, h: 120 }])).toBe(true)
  })

  it('keeps a card right of the one it is near, sliding down past cards in the way', () => {
    const b = board([card('a', 0, 0), card('b', 300, 0)])
    expect(placeNew(b, boxesOf(b.nodes, null), { w: 220, h: 120 }, { near: 'a' })).toEqual({
      x: 300,
      y: 160,
    })
  })

  it('puts a card in its frame after the last card there, and grows the frame around it', () => {
    const frame: CanvasNode = { id: 'f', type: 'frame', x: 0, y: 0, w: 330, h: 220 }
    const empty = board([frame])
    expect(
      placeNew(empty, boxesOf(empty.nodes, null), { w: 220, h: 120 }, { parent: 'f' }),
    ).toEqual({ x: 16, y: 52 })
    const b = board([frame, card('a', 16, 52, { parent: 'f' })])
    const at = placeNew(b, boxesOf(b.nodes, null), { w: 220, h: 120 }, { parent: 'f' })!
    expect(at).toEqual({ x: 316, y: 52 })
    expect(grownFrame({ x: 0, y: 0, w: 330, h: 220 }, { ...at, w: 220, h: 120 })).toEqual({
      w: 552,
      h: 220,
    })
    expect(grownFrame({ x: 0, y: 0, w: 600, h: 300 }, { ...at, w: 220, h: 120 })).toBeNull()
    // A frame not placed yet leaves the card for the board to place.
    const loose = board([{ id: 'g', type: 'frame' }])
    expect(placeNew(loose, boxesOf(loose.nodes, null), { w: 220, h: 120 }, { parent: 'g' })).toBe(
      null,
    )
  })
})

describe('boxesOf', () => {
  it('uses the file box for a card the board has not measured yet (drawn 0 x 0)', () => {
    const nodes = [card('a', 10, 20), card('b', 400, 0)]
    const boxes = boxesOf(nodes, {
      a: { x: 10, y: 20, w: 0, h: 0 },
      b: { x: 400, y: 0, w: 230, h: 130 },
    })
    expect(boxes.get('a')).toEqual({ x: 10, y: 20, w: 220, h: 120 })
    expect(boxes.get('b')).toEqual({ x: 400, y: 0, w: 230, h: 130 })
  })
})

describe('layout helpers', () => {
  it('gives the engine every card with its drawn box, frame, lane and pin', () => {
    const b = board(
      [
        { id: 'lane', type: 'frame', x: 0, y: 0, w: 600, h: 200, data: { variant: 'lane' } },
        card('a', 20, 50, { parent: 'lane', pinned: true }),
        { id: 's', type: 'step' },
        { id: 't', type: 'topic', x: 900, y: 0 },
      ],
      [
        { id: 'a-s', source: 'a', target: 's', label: 'then' },
        { id: 'gone', source: 'a', target: 'nope' },
      ],
    )
    const g = layoutGraph(b, boxesOf(b.nodes, { a: { x: 20, y: 50, w: 230, h: 140 } }))
    expect(g.nodes).toEqual([
      { id: 'lane', w: 600, h: 200, x: 0, y: 0, frame: true, lane: true },
      { id: 'a', w: 230, h: 140, x: 20, y: 50, parent: 'lane', pinned: true },
      { id: 's', ...typicalSize('step') },
      { id: 't', w: 240, h: 120, x: 900, y: 0, topic: true },
    ])
    expect(g.edges).toEqual([{ id: 'a-s', source: 'a', target: 's', label: 'then' }])
  })

  it('carries the cards of a moved frame along unless they have their own spot', () => {
    const b = board([
      { id: 'f', type: 'frame', x: 0, y: 0, w: 600, h: 300 },
      card('a', 20, 50, { parent: 'f' }),
      card('b', 300, 50, { parent: 'f' }),
    ])
    const boxes = boxesOf(b.nodes, null)
    const to = withFrameChildren(
      b,
      boxes,
      new Map([
        ['f', { x: 100, y: 10 }],
        ['b', { x: 500, y: 500 }],
      ]),
    )
    expect(Object.fromEntries(to)).toEqual({
      f: { x: 100, y: 10 },
      a: { x: 120, y: 60 },
      b: { x: 500, y: 500 },
    })
  })

  it('writes new spots, frame sizes and routed links, marking return links as loops', () => {
    const b = board(
      [{ id: 'f', type: 'frame', x: 0, y: 0 }, card('a', 0, 0), card('b', 0, 0, { pinned: true })],
      [
        { id: 'a-b', source: 'a', target: 'b' },
        { id: 'b-a', source: 'b', target: 'a', route: [{ x: 1, y: 1 }] },
        { id: 'b-a-2', source: 'b', target: 'a', tone: 'accent' },
      ],
    )
    const out = arrangeCards(
      b,
      new Map([
        ['a', { x: 10.4, y: 20.6 }],
        ['gone', { x: 1, y: 1 }],
      ]),
      new Map([['f', { w: 400.2, h: 300.7 }]]),
      new Map([
        [
          'a-b',
          {
            sourceHandle: 'right' as const,
            targetHandle: 'left' as const,
            route: [
              { x: 230.4, y: 80 },
              { x: 300, y: 80 },
            ],
            loop: false,
          },
        ],
        [
          'b-a',
          {
            sourceHandle: 'bottom' as const,
            targetHandle: 'bottom' as const,
            route: [
              { x: 1, y: 2 },
              { x: 3, y: 4 },
            ],
            loop: true,
          },
        ],
        [
          'b-a-2',
          {
            sourceHandle: 'top' as const,
            targetHandle: 'top' as const,
            route: [],
            loop: true,
          },
        ],
      ]),
    )
    expect(out.nodes).toEqual([
      { id: 'f', type: 'frame', x: 0, y: 0, w: 400, h: 301 },
      card('a', 10, 21),
      card('b', 0, 0, { pinned: true }),
    ])
    expect(out.edges).toEqual([
      {
        id: 'a-b',
        source: 'a',
        target: 'b',
        sourceHandle: 'right',
        targetHandle: 'left',
        route: [
          { x: 230, y: 80 },
          { x: 300, y: 80 },
        ],
      },
      {
        id: 'b-a',
        source: 'b',
        target: 'a',
        sourceHandle: 'bottom',
        targetHandle: 'bottom',
        tone: 'loop',
        route: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
      // A link with a tone keeps it; a route too short to draw is left out.
      {
        id: 'b-a-2',
        source: 'b',
        target: 'a',
        tone: 'accent',
        sourceHandle: 'top',
        targetHandle: 'top',
      },
    ])
  })
})
