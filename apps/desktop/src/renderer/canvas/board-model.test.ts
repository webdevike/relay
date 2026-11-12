import { describe, expect, it } from 'vitest'
import type { CanvasBoard, CanvasNode } from '@evaos/contract'
import {
  defaultWidth,
  edgeId,
  effectiveLayout,
  engineGraph,
  engineOptions,
  estimateHeight,
  layoutItems,
  nextNoteId,
  placeUnplaced,
  reloadPositions,
  roundHalfAway,
  titleOf,
  visibleShare,
} from './board-model'
import { absolutePositions, toBoard, toFlowEdges, toFlowNodes } from './flow-model'
import type { Point } from './layout'

const node = (
  id: string,
  type: CanvasNode['type'],
  extra: Partial<CanvasNode> = {},
): CanvasNode => ({
  id,
  type,
  ...extra,
})

describe('board helpers (board.rs)', () => {
  it('reload keeps known positions and takes the file’s', () => {
    const incoming = [
      node('moved', 'note', { x: 5, y: 6 }),
      node('kept', 'note'),
      node('new', 'note'),
    ]
    const current = new Map<string, Point>([
      ['moved', [100, 100]],
      ['kept', [40, 50]],
      ['gone', [1, 1]],
    ])
    expect(reloadPositions(incoming, current)).toEqual([
      ['moved', [5, 6]],
      ['kept', [40, 50]],
      ['new', null],
    ])
  })

  it('estimates heights from width and text like native', () => {
    expect(estimateHeight(node('t', 'topic'), 240)).toBe(84)
    expect(estimateHeight(node('t', 'ticket', { h: 300 }), 240)).toBe(300)
    // 40 chars * 6.6 / (220 - 28) = 1.375 -> 2 lines.
    expect(estimateHeight(node('n', 'note', { data: { body: 'x'.repeat(40) } }), 220)).toBe(
      52 + 2 * 18,
    )
    expect(estimateHeight(node('i', 'image'), 240)).toBe(240 * 0.75 + 28)
    expect(
      estimateHeight(
        node('p', 'palette', { data: { colors: Array(5).fill({ hex: '#000' }) } }),
        240,
      ),
    ).toBe(60 + 2 * 72)
    expect(estimateHeight(node('p', 'palette'), 240)).toBe(60 + 72)
    // UTF-8 bytes, as Rust's str::len: "é" is two.
    expect(estimateHeight(node('y', 'typography', { data: { sample: 'é'.repeat(20) } }), 260)).toBe(
      150 + Math.ceil((40 * 7) / 232) * 20,
    )
    expect(defaultWidth('frame')).toBe(330)
    expect(defaultWidth('note')).toBe(220)
    expect(defaultWidth('typography')).toBe(260)
    expect(defaultWidth('palette')).toBe(240)
  })

  it('picks a layout when the file names none', () => {
    expect(effectiveLayout('flow', [node('f', 'frame')], true)).toBe('flow')
    expect(effectiveLayout(undefined, [node('f', 'frame'), node('t', 'topic')], true)).toBe('grid')
    expect(effectiveLayout(undefined, [node('t', 'topic')], true)).toBe('tree')
    expect(effectiveLayout(undefined, [node('n', 'note')], true)).toBe('flow')
    expect(effectiveLayout(undefined, [node('t', 'topic')], false)).toBe('grid')
  })

  it('uses drawn sizes, except for frames', () => {
    const items = layoutItems(
      [node('a', 'note'), node('f', 'frame', { w: 400 })],
      new Map([
        ['a', [222, 99]],
        ['f', [10, 10]],
      ]),
    )
    expect(items[0]).toMatchObject({ w: 222, h: 99 })
    expect(items[1]).toMatchObject({ w: 400, h: 220, frame: true })
  })

  it('lays out the whole board when nothing has a position', () => {
    const nodes = [node('a', 'note'), node('b', 'note')]
    const r = placeUnplaced({
      layout: 'grid',
      nodes,
      edges: [],
      placed: new Map(),
      measured: new Map(),
      unplaced: ['a', 'b'],
    })
    expect(r.positions.get('a')).toEqual([0, 0])
    expect(r.positions.get('b')![1]).toBeGreaterThan(0)
  })

  it('puts a new node under its siblings in a placed frame, growing the frame', () => {
    const nodes = [
      node('f', 'frame', { x: 100, y: 100, w: 300, h: 200 }),
      node('c1', 'note', { x: 116, y: 136, parent: 'f' }),
      node('c2', 'note', { parent: 'f' }),
    ]
    const r = placeUnplaced({
      layout: 'grid',
      nodes,
      edges: [],
      placed: new Map<string, Point>([
        ['f', [100, 100]],
        ['c1', [116, 136]],
      ]),
      measured: new Map([['c1', [220, 80]]]),
      unplaced: ['c2'],
    })
    // Under c1 (136 + 80) plus the inner gap.
    expect(r.positions.get('c2')).toEqual([116, 136 + 80 + 16])
    const c2h = estimateHeight(nodes[2]!, 220)
    expect(r.frameSizes.get('f')).toEqual([300, 136 + 80 + 16 + c2h + 16 - 100])
  })

  it('lays out loose new nodes to the right of the board', () => {
    const r = placeUnplaced({
      layout: 'grid',
      nodes: [node('a', 'note', { x: -50, y: 20 }), node('b', 'note')],
      edges: [],
      placed: new Map<string, Point>([['a', [-50, 20]]]),
      measured: new Map([['a', [220, 80]]]),
      unplaced: ['b'],
    })
    expect(r.positions.get('b')).toEqual([-50 + 220 + 120, 20])
  })

  it('names titles, note ids and edge ids like native', () => {
    expect(titleOf(node('a', 'ticket', { data: { key: 'ENG-1' } }))).toBe('ENG-1')
    expect(titleOf(node('a', 'image', { data: { caption: 'c' } }))).toBe('c')
    expect(titleOf(node('a', 'note'))).toBe('')
    expect(nextNoteId(['a', 'note-3'])).toBe('note-4')
    expect(nextNoteId(['note-2', 'b'])).toBe('note-3')
    expect(edgeId('a', 'b', ['a-b'])).toBe('a-b-2')
    expect(roundHalfAway(-0.5)).toBe(-1)
    expect(roundHalfAway(2.5)).toBe(3)
    expect(Object.is(roundHalfAway(-0.2), 0)).toBe(true)
  })
})

describe('React Flow model', () => {
  const board: CanvasBoard = {
    version: 1,
    title: 'Data table mockups',
    layout: 'grid',
    nodes: [
      node('img-1', 'image', { x: 116, y: 136, parent: 'dense', data: { title: 'Ops table' } }),
      node('dense', 'frame', { x: 100, y: 100, w: 300, h: 400, data: { title: 'Dense / ops' } }),
      node('palette', 'palette', { x: 10, y: -20, data: { colors: [{ hex: '#24837B' }] } }),
    ],
    edges: [
      { id: 'e1', source: 'palette', target: 'dense', label: 'informs', tone: 'accent' },
      { id: 'e2', source: 'palette', target: 'img-1', tone: 'default', sourceHandle: 'right' },
    ],
  }
  const at = new Map(board.nodes.map((n) => [n.id, [n.x!, n.y!] as Point]))

  it('puts parents first with children relative to them', () => {
    const nodes = toFlowNodes(board.nodes, at)
    expect(nodes.map((n) => n.id)).toEqual(['dense', 'palette', 'img-1'])
    const child = nodes.find((n) => n.id === 'img-1')!
    expect(child.parentId).toBe('dense')
    expect(child.expandParent).toBe(true)
    expect(child.position).toEqual({ x: 16, y: 36 })
    expect(nodes.find((n) => n.id === 'dense')).toMatchObject({ width: 300, height: 400 })
    expect(nodes.find((n) => n.id === 'dense')!.data.hasChildren).toBe(true)
    expect(absolutePositions(nodes).get('img-1')).toEqual([116, 136])
  })

  it('writes the board back in file order with the same positions', () => {
    const doc = {
      title: board.title,
      layout: board.layout,
      nodes: toFlowNodes(board.nodes, at),
      edges: toFlowEdges(board.edges),
    }
    const out = toBoard(doc, { x: 12.4, y: -3.5, zoom: 0.316 })
    expect(out.nodes).toEqual(board.nodes)
    // Default tones are not written.
    expect(out.edges).toEqual([
      board.edges[0],
      { id: 'e2', source: 'palette', target: 'img-1', sourceHandle: 'right' },
    ])
    expect(out.viewport).toEqual({ x: 12, y: -4, zoom: 0.32 })
    expect(Object.keys(out)).toEqual(['version', 'title', 'layout', 'nodes', 'edges', 'viewport'])
  })

  it('ignores a parent that is not a frame or loops', () => {
    const nodes = toFlowNodes(
      [
        node('a', 'note', { parent: 'b' }),
        node('b', 'note'),
        node('f1', 'frame', { parent: 'f2' }),
        node('f2', 'frame', { parent: 'f1' }),
      ],
      new Map(),
    )
    expect(nodes.every((n) => n.parentId === undefined)).toBe(true)
  })

  it('keeps a frame without a file size unsized when it was not resized', () => {
    const nodes = toFlowNodes([node('f', 'frame', { x: 0, y: 0 })], new Map([['f', [0, 0]]]))
    expect(toBoard({ title: 't', layout: undefined, nodes, edges: [] }, null).nodes).toEqual([
      { id: 'f', type: 'frame', x: 0, y: 0 },
    ])
    nodes[0]!.width = 401.6
    expect(
      toBoard({ title: 't', layout: undefined, nodes, edges: [] }, null).nodes[0],
    ).toMatchObject({ w: 402 })
  })

  it("writes a live ui card's size once its handles resized it, not before", () => {
    const nodes = toFlowNodes([node('u', 'ui', { x: 0, y: 0 })], new Map([['u', [0, 0]]]))
    expect(toBoard({ title: 't', layout: undefined, nodes, edges: [] }, null).nodes).toEqual([
      { id: 'u', type: 'ui', x: 0, y: 0 },
    ])
    nodes[0]!.width = 512.4
    nodes[0]!.height = 300
    expect(
      toBoard({ title: 't', layout: undefined, nodes, edges: [] }, null).nodes[0],
    ).toMatchObject({ w: 512, h: 300 })
  })

  it('writes a pin as the card has it, and none on a card never dragged', () => {
    const specs = [
      node('a', 'note', { x: 0, y: 0, pinned: true }),
      node('b', 'note', { x: 9, y: 9 }),
    ]
    const at = new Map<string, Point>([
      ['a', [0, 0]],
      ['b', [9, 9]],
    ])
    const out = toBoard(
      { title: 't', layout: undefined, nodes: toFlowNodes(specs, at), edges: [] },
      null,
    )
    expect(out.nodes).toEqual(specs)
    // The file's key order (CanvasNodeSchema), so a loaded board saves as it came.
    expect(Object.keys(out.nodes[0]!)).toEqual(['id', 'type', 'x', 'y', 'pinned'])
  })
})

describe('visibleShare', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 500 }
  it('measures how much of the board a viewport shows', () => {
    expect(visibleShare(bounds, { x: 0, y: 0, zoom: 1 }, 1000, 500)).toBe(1)
    expect(visibleShare(bounds, { x: -500, y: 0, zoom: 1 }, 1000, 500)).toBe(0.5)
    // Panned right past the board, as a viewport saved in a wider window.
    expect(visibleShare(bounds, { x: 2000, y: 0, zoom: 1 }, 1000, 500)).toBe(0)
    // Zoomed out, a small pane shows everything.
    expect(visibleShare(bounds, { x: 0, y: 0, zoom: 0.25 }, 250, 125)).toBe(1)
    expect(visibleShare({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, zoom: 1 }, 10, 10)).toBe(
      1,
    )
  })
})

describe('layout engine glue', () => {
  it('picks the engine algorithm from the board layout', () => {
    const topic = [node('t', 'topic')]
    expect(engineOptions('flow', [], true)).toEqual({
      algorithm: 'layered',
      direction: 'right',
      spacing: 56,
      keepPinned: true,
      only: null,
    })
    expect(engineOptions('grid', [], false)).toMatchObject({ algorithm: 'grid', keepPinned: false })
    expect(engineOptions('tree', topic, true).algorithm).toBe('radial')
    expect(engineOptions('tree', [], true).algorithm).toBe('mrtree')
  })

  it('hands the engine drawn sizes, frames, lanes, pins and the links between cards', () => {
    const nodes = [
      node('lane', 'frame', { w: 600, h: 200, data: { variant: 'lane' } }),
      node('a', 'note', { parent: 'lane', pinned: true }),
      node('b', 'step', { parent: 'a' }),
      node('t', 'topic'),
    ]
    const g = engineGraph(
      nodes,
      [
        { id: 'a-b', source: 'a', target: 'b', label: 'then', tone: undefined },
        { id: 'a-x', source: 'a', target: 'x' },
      ],
      new Map<string, Point>([['a', [10, 20]]]),
      new Map([['a', [230, 140] as const]]),
    )
    expect(g.nodes).toEqual([
      { id: 'lane', w: 600, h: 200, frame: true, lane: true },
      { id: 'a', w: 230, h: 140, x: 10, y: 20, parent: 'lane', pinned: true },
      // A parent that is not a frame is no parent.
      { id: 'b', w: 300, h: estimateHeight(nodes[2]!, 300) },
      {
        id: 't',
        w: defaultWidth('topic'),
        h: estimateHeight(nodes[3]!, defaultWidth('topic')),
        topic: true,
      },
    ])
    expect(g.edges).toEqual([{ id: 'a-b', source: 'a', target: 'b', label: 'then' }])
  })
})
