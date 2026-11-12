import { describe, expect, it } from 'vitest'
import { layoutBoard, routeCrossesCards } from './index'
import type {
  Box,
  LayoutDirection,
  LayoutEdge,
  LayoutNode,
  LayoutOptions,
  LayoutResult,
} from './types'

const opts = (o: Partial<LayoutOptions> = {}): LayoutOptions => ({
  algorithm: 'layered',
  direction: 'right',
  spacing: 48,
  keepPinned: true,
  ...o,
})

const card = (id: string, extra: Partial<LayoutNode> = {}): LayoutNode => ({
  id,
  w: 320,
  h: 110,
  ...extra,
})
const link = (source: string, target: string, extra: Partial<LayoutEdge> = {}): LayoutEdge => ({
  id: `${source}>${target}`,
  source,
  target,
  ...extra,
})

/** Every card's final box: moved ones from the result, the rest where they were. */
function finalBoxes(nodes: LayoutNode[], res: LayoutResult): Map<string, Box> {
  const out = new Map<string, Box>()
  for (const n of nodes) {
    const p =
      res.positions.get(n.id) ??
      (n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : null)
    if (!p) continue
    const s = res.frameSizes.get(n.id) ?? { w: n.w, h: n.h }
    out.set(n.id, { x: p.x, y: p.y, w: s.w, h: s.h })
  }
  return out
}

function ancestors(nodes: LayoutNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: string[] = []
  for (let p = byId.get(id)?.parent; p !== undefined; p = byId.get(p)?.parent) out.push(p)
  return out
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** No overlaps (bar a frame and what is inside it); every route clean. */
function expectClean(nodes: LayoutNode[], edges: LayoutEdge[], res: LayoutResult) {
  const boxes = finalBoxes(nodes, res)
  const ids = [...boxes.keys()]
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!
      const b = ids[j]!
      if (ancestors(nodes, a).includes(b) || ancestors(nodes, b).includes(a)) continue
      expect(overlap(boxes.get(a)!, boxes.get(b)!), `${a} overlaps ${b}`).toBe(false)
    }
  for (const [id, p] of res.positions) {
    expect(Number.isInteger(p.x) && Number.isInteger(p.y), id).toBe(true)
  }
  for (const [id, laid] of res.edges) {
    const e = edges.find((x) => x.id === id)!
    const r = laid.route
    expect(r.length, id).toBeGreaterThanOrEqual(2)
    expect(r.length, id).toBeLessThanOrEqual(40)
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1]!
      const b = r[i]!
      expect(a.x === b.x || a.y === b.y, `${id} segment ${i} orthogonal`).toBe(true)
      expect(Number.isInteger(b.x) && Number.isInteger(b.y), id).toBe(true)
    }
    const S = boxes.get(e.source)!
    const T = boxes.get(e.target)!
    expectOnSide(S, laid.sourceHandle, r[0]!, `${id} source`)
    expectOnSide(T, laid.targetHandle, r[r.length - 1]!, `${id} target`)
    const skip = new Set([
      e.source,
      e.target,
      ...ancestors(nodes, e.source),
      ...ancestors(nodes, e.target),
    ])
    const others = [...boxes].filter(([k]) => !skip.has(k)).map(([, b]) => b)
    expect(routeCrossesCards(r, others), `${id} crosses a card`).toBe(false)
  }
}

function expectOnSide(b: Box, side: string, p: { x: number; y: number }, what: string) {
  const near = (v: number, w: number) => Math.abs(v - w) <= 1
  const inX = p.x >= b.x - 1 && p.x <= b.x + b.w + 1
  const inY = p.y >= b.y - 1 && p.y <= b.y + b.h + 1
  const ok =
    side === 'left'
      ? near(p.x, b.x) && inY
      : side === 'right'
        ? near(p.x, b.x + b.w) && inY
        : side === 'top'
          ? near(p.y, b.y) && inX
          : near(p.y, b.y + b.h) && inX
  expect(ok, `${what} on ${side}`).toBe(true)
}

/**
 * Two phase lanes (5 and 6 steps), a judge/fix loop, a step skipped, links across, a topic
 * linked to no step, three explainers linked to steps and two cards linked to nothing.
 */
function cook(): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const heights = [110, 104, 118, 110, 112, 108]
  const nodes: LayoutNode[] = [
    { id: 'setup', w: 400, h: 220, frame: true, lane: true },
    { id: 'loop', w: 400, h: 220, frame: true, lane: true },
  ]
  for (let i = 1; i <= 5; i++) nodes.push(card(`s${i}`, { parent: 'setup', h: heights[i - 1]! }))
  for (const [i, id] of ['pick', 'fix', 'test', 'judge', 'gate', 'ship'].entries())
    nodes.push(card(id, { parent: 'loop', h: heights[i]! }))
  nodes.push(card('why1', { h: 180 }), card('why2', { h: 140 }), card('why3', { h: 220 }))
  nodes.push(card('topic', { w: 560, h: 120, topic: true }))
  nodes.push(card('aside', { w: 340, h: 230 }), card('note', { w: 240, h: 150 }))
  const edges: LayoutEdge[] = [
    link('s1', 's2'),
    link('s2', 's3'),
    link('s3', 's4'),
    link('s4', 's5'),
    link('pick', 'fix', { label: 'below the bar' }),
    link('fix', 'test'),
    link('test', 'judge'),
    link('judge', 'gate'),
    link('gate', 'ship'),
    link('judge', 'fix', { label: 'next round' }),
    link('gate', 'fix'),
    link('test', 'gate', { label: 'static at bar' }),
    link('s5', 'pick', { label: 'start' }),
    link('s5', 'ship'),
    link('why3', 'gate'),
    link('test', 'why2'),
    link('why1', 's2'),
  ]
  // Lanes listed in the file after the steps would not change their order: dependency rules.
  return { nodes: [nodes[1]!, ...nodes.slice(2), nodes[0]!], edges }
}

const LOOP_STEPS = ['pick', 'fix', 'test', 'judge', 'gate', 'ship']

describe.each<LayoutDirection>(['right', 'down'])('cook board, %s', (direction) => {
  it('lays lanes out as aligned bands with clean routes', async () => {
    const { nodes, edges } = cook()
    const res = await layoutBoard(nodes, edges, opts({ direction }))
    expectClean(nodes, edges, res)
    const boxes = finalBoxes(nodes, res)
    const setup = boxes.get('setup')!
    const loop = boxes.get('loop')!
    if (direction === 'right') {
      expect(setup.w).toBe(loop.w)
      expect(setup.x).toBe(loop.x)
      expect(loop.y).toBeGreaterThan(setup.y + setup.h)
    } else {
      expect(setup.h).toBe(loop.h)
      expect(setup.y).toBe(loop.y)
      expect(loop.x).toBeGreaterThan(setup.x + setup.w)
    }
    // Steps inside their lane, under its heading.
    for (const n of nodes) {
      if (!n.parent) continue
      const b = boxes.get(n.id)!
      const lane = boxes.get(n.parent)!
      expect(b.x).toBeGreaterThanOrEqual(lane.x + 16)
      expect(b.y).toBeGreaterThanOrEqual(lane.y + 44)
      expect(b.x + b.w).toBeLessThanOrEqual(lane.x + lane.w)
      expect(b.y + b.h).toBeLessThanOrEqual(lane.y + lane.h)
    }
    // Children start at the same place in every lane.
    for (const lane of [setup, loop]) {
      const kids = nodes
        .filter((n) => n.parent && boxes.get(n.parent) === lane)
        .map((n) => boxes.get(n.id)!)
      if (direction === 'right') expect(Math.min(...kids.map((b) => b.x))).toBe(lane.x + 16)
      else expect(Math.min(...kids.map((b) => b.y))).toBe(lane.y + 60)
    }
    // A chain reads along the flow.
    for (let i = 1; i < 5; i++) {
      const a = boxes.get(`s${i}`)!
      const b = boxes.get(`s${i + 1}`)!
      if (direction === 'right') expect(b.x).toBeGreaterThan(a.x + a.w)
      else expect(b.y).toBeGreaterThan(a.y + a.h)
    }
    // Loose explainers beside the lanes, not in them.
    for (const id of ['why1', 'why2', 'why3']) {
      const b = boxes.get(id)!
      if (direction === 'right')
        expect(b.x).toBeGreaterThan(Math.max(setup.x + setup.w, loop.x + loop.w))
      else expect(b.y).toBeGreaterThan(Math.max(setup.y + setup.h, loop.y + loop.h))
    }
    const loops = [...res.edges].filter(([, e]) => e.loop).map(([id]) => id)
    expect(loops.sort()).toEqual(['gate>fix', 'judge>fix'])
    const back = direction === 'right' ? 'bottom' : 'right'
    for (const id of loops) {
      expect(res.edges.get(id)!.sourceHandle).toBe(back)
      expect(res.edges.get(id)!.targetHandle).toBe(back)
    }
    const flowOut = direction === 'right' ? 'right' : 'bottom'
    const flowIn = direction === 'right' ? 'left' : 'top'
    for (const id of ['s1>s2', 'pick>fix', 'gate>ship']) {
      expect(res.edges.get(id)!.sourceHandle).toBe(flowOut)
      expect(res.edges.get(id)!.targetHandle).toBe(flowIn)
    }
    // Across lanes: out of the side facing the next lane, through the gutter.
    const across = direction === 'right' ? ['bottom', 'top'] : ['right', 'left']
    for (const id of ['s5>pick', 's5>ship']) {
      const e = res.edges.get(id)!
      expect([e.sourceHandle, e.targetHandle]).toEqual(across)
    }
    expect(res.edges.size).toBe(edges.length)
  })

  it('lays each lane out as one numbered row with arcs inside the lane', async () => {
    const { nodes, edges } = cook()
    const res = await layoutBoard(nodes, edges, opts({ direction }))
    const boxes = finalBoxes(nodes, res)
    const rows = direction === 'right'
    const along = (b: Box) => (rows ? b.x : b.y)
    const across = (b: Box) => (rows ? b.y : b.x)
    // One row (column for `down`) in input order, aligned on its start.
    const steps = LOOP_STEPS.map((id) => boxes.get(id)!)
    for (let i = 1; i < steps.length; i++) {
      expect(across(steps[i]!)).toBe(across(steps[0]!))
      expect(along(steps[i]!)).toBeGreaterThan(along(steps[i - 1]!))
    }
    // A labelled neighbour link leaves room for its pill.
    const pick = boxes.get('pick')!
    const fix = boxes.get('fix')!
    const gap = rows ? fix.x - pick.x - pick.w : fix.y - pick.y - pick.h
    expect(gap).toBeGreaterThanOrEqual(rows ? 'below the bar'.length * 6.5 + 32 : 56)
    // The skip arcs over the row, loops under it; every link between two steps of a lane stays
    // inside the lane, under its heading.
    const skip = res.edges.get('test>gate')!
    expect(skip.loop).toBe(false)
    expect([skip.sourceHandle, skip.targetHandle]).toEqual(rows ? ['top', 'top'] : ['left', 'left'])
    for (const e of edges) {
      const p = nodes.find((n) => n.id === e.source)!.parent
      if (!p || p !== nodes.find((n) => n.id === e.target)!.parent) continue
      const lane = boxes.get(p)!
      for (const q of res.edges.get(e.id)!.route) {
        expect(q.x, e.id).toBeGreaterThanOrEqual(lane.x)
        expect(q.x, e.id).toBeLessThanOrEqual(lane.x + lane.w)
        expect(q.y, e.id).toBeGreaterThanOrEqual(lane.y + 44)
        expect(q.y, e.id).toBeLessThanOrEqual(lane.y + lane.h)
      }
    }
    // The link from the other lane drops through the gap beside its target step.
    const fixBox = boxes.get('fix')!
    const drop = res.edges.get('s5>pick')!.route
    const inGap = drop.slice(1).some((b, k) => {
      const a = drop[k]!
      return rows
        ? a.x === b.x && a.x > pick.x + pick.w && a.x < fixBox.x
        : a.y === b.y && a.y > pick.y + pick.h && a.y < fixBox.y
    })
    expect(inGap).toBe(true)
    // The topic heads the lanes from their left edge; explainers follow the steps they link.
    const topic = boxes.get('topic')!
    const setup = boxes.get('setup')!
    expect(topic.x).toBe(setup.x)
    expect(topic.y + topic.h).toBeLessThan(Math.min(setup.y, boxes.get('loop')!.y))
    const [w1, w2, w3] = ['why1', 'why2', 'why3'].map((id) => boxes.get(id)!)
    expect(across(w1!)).toBeLessThan(across(w2!))
    expect(across(w2!)).toBeLessThan(across(w3!))
    // Cards linked to nothing sit on a shelf 1.5 x spacing past the lanes, from their left edge,
    // in input order, top aligned.
    const loop = boxes.get('loop')!
    const lanesEnd = rows
      ? Math.max(setup.y + setup.h, loop.y + loop.h)
      : Math.max(setup.x + setup.w, loop.x + loop.w)
    const [aside, note] = ['aside', 'note'].map((id) => boxes.get(id)!)
    expect(across(aside!)).toBe(lanesEnd + 72)
    expect(along(aside!)).toBe(rows ? setup.x : setup.y)
    expect(across(note!)).toBe(across(aside!))
    expect(along(note!)).toBe(along(aside!) + (rows ? aside!.w : aside!.h) + 48)
  })

  it('puts cards linked to nothing on a shelf that wraps at the lanes', async () => {
    const { nodes, edges } = cook()
    const unlinked = new Set(['why1', 'why2', 'why3'])
    const kept = edges.filter((e) => !unlinked.has(e.source) && !unlinked.has(e.target))
    const extra = Array.from({ length: 6 }, (_, i) => card(`wide${i}`, { w: 520, h: 200 + i * 10 }))
    const all = [...nodes, ...extra]
    const res = await layoutBoard(all, kept, opts({ direction }))
    expectClean(all, kept, res)
    const boxes = finalBoxes(all, res)
    const rows = direction === 'right'
    const along = (b: Box) => (rows ? b.x : b.y)
    const across = (b: Box) => (rows ? b.y : b.x)
    const alongLen = (b: Box) => (rows ? b.w : b.h)
    const setup = boxes.get('setup')!
    const loop = boxes.get('loop')!
    const start = along(setup)
    const length = alongLen(setup)
    const lanesEnd = Math.max(
      across(setup) + (rows ? setup.h : setup.w),
      across(loop) + (rows ? loop.h : loop.w),
    )
    const shelf = ['why1', 'why2', 'why3', 'aside', 'note', ...extra.map((n) => n.id)].map((id) =>
      boxes.get(id)!,
    )
    expect(across(shelf[0]!)).toBe(lanesEnd + 72)
    // Shelf rows: each starts at the lanes' left edge, stays within their length, top aligned,
    // in input order.
    const shelfRows = new Map<number, Box[]>()
    for (const b of shelf) shelfRows.set(across(b), [...(shelfRows.get(across(b)) ?? []), b])
    expect(shelfRows.size).toBeGreaterThan(1)
    let prev = -Infinity
    for (const [v, row] of [...shelfRows].sort((a, b) => a[0] - b[0])) {
      expect(v).toBeGreaterThan(prev)
      prev = v + Math.max(...row.map((b) => (rows ? b.h : b.w)))
      expect(along(row[0]!)).toBe(start)
      for (const b of row) expect(along(b) + alongLen(b)).toBeLessThanOrEqual(start + length)
    }
    for (let i = 1; i < shelf.length; i++) {
      const [a, b] = [shelf[i - 1]!, shelf[i]!]
      expect(across(b) > across(a) || (across(b) === across(a) && along(b) > along(a))).toBe(true)
    }
  })

  it('is deterministic', async () => {
    const { nodes, edges } = cook()
    const a = await layoutBoard(nodes, edges, opts({ direction }))
    const b = await layoutBoard(nodes, edges, opts({ direction }))
    expect(b).toEqual(a)
  })
})

describe('layoutBoard', () => {
  it('lays a 12 card flow with a diamond along the flow', async () => {
    const ids = 'abcdefghijkl'.split('')
    const nodes = ids.map((id, i) => card(id, { w: 240 + (i % 3) * 40, h: 90 + (i % 4) * 10 }))
    const edges = [
      link('a', 'b'),
      link('a', 'c'),
      link('b', 'd'),
      link('c', 'd'),
      ...ids.slice(3, -1).map((id, i) => link(id, ids[i + 4]!)),
    ]
    for (const direction of ['right', 'down'] as const) {
      const res = await layoutBoard(nodes, edges, opts({ direction }))
      expectClean(nodes, edges, res)
      expect(res.positions.size).toBe(12)
      expect([...res.edges.values()].every((e) => !e.loop)).toBe(true)
      const boxes = finalBoxes(nodes, res)
      const a = boxes.get('a')!
      const d = boxes.get('d')!
      if (direction === 'right') expect(d.x).toBeGreaterThan(a.x + a.w)
      else expect(d.y).toBeGreaterThan(a.y + a.h)
    }
  })

  it('wraps a long lane into even rows, the link between rows dropping through the gap', async () => {
    const lane = (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`)
      const nodes: LayoutNode[] = [
        { id: 'lane', w: 400, h: 200, frame: true, lane: true },
        ...ids.map((id) => card(id, { parent: 'lane' })),
      ]
      const edges = ids.slice(0, -1).map((id, i) => link(id, ids[i + 1]!))
      return { ids, nodes, edges }
    }
    for (const direction of ['right', 'down'] as const) {
      const rows = direction === 'right'
      // Rows of a lane: steps grouped by where they sit across it, in order.
      const split = async (n: number) => {
        const { ids, nodes, edges } = lane(n)
        const res = await layoutBoard(nodes, edges, opts({ direction }))
        const across = (id: string) => (rows ? res.positions.get(id)!.y : res.positions.get(id)!.x)
        const sizes: number[] = []
        ids.forEach((id, i) => {
          if (i === 0 || across(id) !== across(ids[i - 1]!)) sizes.push(1)
          else sizes[sizes.length - 1]! += 1
        })
        return sizes
      }
      expect(await split(6)).toEqual([6])
      expect(await split(7)).toEqual([4, 3])
      expect(await split(12)).toEqual([6, 6])

      const { nodes, edges } = lane(8)
      edges.push(link('p8', 'p2'))
      const res = await layoutBoard(nodes, edges, opts({ direction }))
      expectClean(nodes, edges, res)
      const boxes = finalBoxes(nodes, res)
      const b = (id: string) => boxes.get(id)!
      const across = (id: string) => (rows ? b(id).y : b(id).x)
      const along = (id: string) => (rows ? b(id).x : b(id).y)
      for (const id of ['p2', 'p3', 'p4']) expect(across(id)).toBe(across('p1'))
      for (const id of ['p6', 'p7', 'p8']) expect(across(id)).toBe(across('p5'))
      expect(across('p5')).toBeGreaterThan(across('p1') + 110)
      expect(along('p5')).toBe(along('p1'))
      expect(res.edges.get('p8>p2')!.loop).toBe(true)
      // p4 ends row one, p5 starts row two: out of p4's bottom, level through the gap between
      // the rows, into p5's top (right and left for `down`), staying in the lane.
      const drop = res.edges.get('p4>p5')!
      expect(drop.loop).toBe(false)
      expect([drop.sourceHandle, drop.targetHandle]).toEqual(
        rows ? ['bottom', 'top'] : ['right', 'left'],
      )
      expect(drop.route).toHaveLength(4)
      const level = rows ? drop.route[1]!.y : drop.route[1]!.x
      const rowOneEnd = Math.max(
        ...['p1', 'p2', 'p3', 'p4'].map((id) => across(id) + (rows ? b(id).h : b(id).w)),
      )
      expect(level).toBeGreaterThan(rowOneEnd)
      expect(level).toBeLessThan(across('p5'))
      const L = b('lane')
      for (const q of drop.route) {
        expect(q.x).toBeGreaterThanOrEqual(L.x)
        expect(q.x).toBeLessThanOrEqual(L.x + L.w)
        expect(q.y).toBeGreaterThanOrEqual(L.y + 44)
        expect(q.y).toBeLessThanOrEqual(L.y + L.h)
      }
    }
  })

  it('flags and routes a cycle', async () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => card(id))
    const edges = [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('d', 'b'), link('c', 'c')]
    const res = await layoutBoard(nodes, edges, opts())
    expectClean(nodes, edges, res)
    expect(res.edges.get('d>b')!.loop).toBe(true)
    expect(res.edges.get('c>c')!.loop).toBe(true)
    expect(res.edges.get('a>b')!.loop).toBe(false)
    expect(res.edges.get('d>b')!.sourceHandle).toBe('bottom')
  })

  it('makes a uniform grid of mixed cards', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      card(`g${i}`, { w: 150 + (i % 3) * 70, h: 60 + (i % 4) * 35 }),
    )
    const edges = [link('g0', 'g5'), link('g9', 'g1'), link('g3', 'g4')]
    const res = await layoutBoard(nodes, edges, opts({ algorithm: 'grid' }))
    expectClean(nodes, edges, res)
    const p = (i: number) => res.positions.get(`g${i}`)!
    // 4 columns: rows share a top, columns a left.
    for (let i = 0; i < 10; i++) {
      expect(p(i).y).toBe(p(Math.floor(i / 4) * 4).y)
      expect(p(i).x).toBe(p(i % 4).x)
    }
    const three = await layoutBoard(nodes, [], opts({ algorithm: 'grid', columns: 3 }))
    expect(three.positions.get('g3')!.x).toBe(three.positions.get('g0')!.x)
  })

  it.each(['radial', 'mrtree'] as const)('lays a tree of 12 with %s', async (algorithm) => {
    const nodes = Array.from({ length: 12 }, (_, i) =>
      card(`t${i}`, { w: 200, h: 80, topic: i === 0 }),
    )
    const edges = Array.from({ length: 11 }, (_, i) => link(`t${Math.floor(i / 3)}`, `t${i + 1}`))
    const res = await layoutBoard(nodes, edges, opts({ algorithm }))
    expectClean(nodes, edges, res)
    expect(res.positions.size).toBe(12)
    if (algorithm === 'mrtree') {
      const root = res.positions.get('t0')!
      for (let i = 1; i < 12; i++) expect(res.positions.get(`t${i}`)!.x).toBeGreaterThan(root.x)
    }
  })

  it('keeps pinned cards and lays the rest around them', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => card(id))
    nodes.push(card('pin', { x: 380, y: 0, w: 300, h: 200, pinned: true }))
    const edges = [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('d', 'e'), link('pin', 'c')]
    const res = await layoutBoard(nodes, edges, opts())
    expect(res.positions.has('pin')).toBe(false)
    expect(res.kept).toEqual(['pin'])
    expectClean(nodes, edges, res)
    expect(res.edges.has('pin>c')).toBe(true)
    // Not pinned when the option is off.
    const free = await layoutBoard(nodes, edges, opts({ keepPinned: false }))
    expect(free.positions.has('pin')).toBe(true)
    expect(free.kept).toEqual([])
  })

  it('slides a placed flow past a pinned card in its way', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id, i) => card(id, { x: i * 400, y: 0 }))
    nodes.push(card('pin', { x: 700, y: -20, w: 260, h: 160, pinned: true }))
    const edges = [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('d', 'e'), link('c', 'pin')]
    for (const direction of ['right', 'down'] as const) {
      const res = await layoutBoard(nodes, edges, opts({ direction }))
      expect(res.positions.has('pin')).toBe(false)
      expectClean(nodes, edges, res)
      // Starts where the cards were.
      expect(res.positions.get('a')).toEqual({ x: 0, y: 0 })
    }
  })

  it('keeps a pinned frame with its children', async () => {
    const nodes = [
      card('f', { frame: true, x: 0, y: 0, w: 400, h: 300, pinned: true }),
      card('k', { parent: 'f', x: 20, y: 60 }),
      card('a'),
      card('b'),
    ]
    const edges = [link('a', 'b'), link('b', 'k')]
    const res = await layoutBoard(nodes, edges, opts())
    expect(res.kept).toEqual(['f', 'k'])
    expect([...res.positions.keys()].sort()).toEqual(['a', 'b'])
    expectClean(nodes, edges, res)
  })

  it('lays a frame out inside and the board around it', async () => {
    const nodes = [
      card('start'),
      card('f', { frame: true, w: 200, h: 100 }),
      card('x', { parent: 'f' }),
      card('y', { parent: 'f' }),
      card('z', { parent: 'f' }),
      card('end'),
    ]
    const edges = [
      link('start', 'x'),
      link('x', 'y'),
      link('x', 'z'),
      link('y', 'end'),
      link('z', 'end'),
    ]
    for (const direction of ['right', 'down'] as const) {
      const res = await layoutBoard(nodes, edges, opts({ direction }))
      expectClean(nodes, edges, res)
      const boxes = finalBoxes(nodes, res)
      const f = boxes.get('f')!
      for (const id of ['x', 'y', 'z']) {
        const b = boxes.get(id)!
        expect(b.x).toBeGreaterThanOrEqual(f.x + 16)
        expect(b.y).toBeGreaterThanOrEqual(f.y + 52)
        expect(b.x + b.w).toBeLessThanOrEqual(f.x + f.w - 16)
        expect(b.y + b.h).toBeLessThanOrEqual(f.y + f.h - 16)
      }
    }
  })

  it('moves an `only` set that lands on a card that stays', async () => {
    const nodes = [
      card('a', { x: 0, y: 0 }),
      card('b', { x: 0, y: 200 }),
      card('stay', { x: 300, y: 0, w: 200, h: 400 }),
    ]
    const edges = [link('a', 'b'), link('b', 'stay')]
    const res = await layoutBoard(nodes, edges, opts({ only: new Set(['a', 'b']) }))
    expect(res.positions.has('stay')).toBe(false)
    expectClean(nodes, edges, res)
  })

  it('moves only the cards asked, from where they were', async () => {
    const nodes = [
      card('a', { x: 1000, y: 500 }),
      card('b', { x: 1500, y: 900 }),
      card('c', { x: 0, y: 0 }),
      card('d', { x: 1400, y: 500 }),
    ]
    const edges = [link('a', 'b'), link('c', 'd')]
    const res = await layoutBoard(nodes, edges, opts({ only: new Set(['a', 'b']) }))
    expect([...res.positions.keys()].sort()).toEqual(['a', 'b'])
    expect(res.positions.get('a')!.y).toBe(500)
    expectClean(nodes, edges, res)
    expect(res.edges.has('c>d')).toBe(false)
  })

  it('brings a frame and its children with `only`, growing the frame', async () => {
    const nodes = [
      card('f', { frame: true, x: 0, y: 0, w: 200, h: 100 }),
      card('k1', { parent: 'f' }),
      card('k2', { parent: 'f' }),
      card('out', { x: 2000, y: 0 }),
    ]
    const edges = [link('k1', 'k2')]
    const res = await layoutBoard(nodes, edges, opts({ only: new Set(['f']) }))
    expect([...res.positions.keys()].sort()).toEqual(['f', 'k1', 'k2'])
    const f = res.frameSizes.get('f')!
    expect(f.w).toBeGreaterThanOrEqual(320 * 2 + 32)
    expectClean(nodes, edges, res)
  })

  it('handles empty and single boards and ignores links to unknown cards', async () => {
    const empty = await layoutBoard([], [link('x', 'y')], opts())
    expect(
      empty.positions.size + empty.edges.size + empty.frameSizes.size + empty.kept.length,
    ).toBe(0)
    const one = await layoutBoard([card('a')], [link('a', 'ghost'), link('ghost', 'a')], opts())
    expect(one.positions).toEqual(new Map([['a', { x: 0, y: 0 }]]))
    expect(one.edges.size).toBe(0)
    const placed = await layoutBoard([card('a', { x: 40, y: 70 })], [], opts({ algorithm: 'grid' }))
    expect(placed.positions.get('a')).toEqual({ x: 40, y: 70 })
  })
})
