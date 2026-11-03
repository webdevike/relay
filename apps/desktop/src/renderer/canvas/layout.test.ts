import { describe, expect, it } from 'vitest'
import { place, type LayoutItem, type Placement } from './layout'

const item = (id: string, w: number, h: number, extra: Partial<LayoutItem> = {}): LayoutItem => ({
  id,
  w,
  h,
  frame: false,
  parent: null,
  topic: false,
  ...extra,
})

type Rect = [number, number, number, number]

const overlaps = (a: Rect, b: Rect): boolean =>
  a[0] < b[0] + b[2] - 0.01 &&
  b[0] < a[0] + a[2] - 0.01 &&
  a[1] < b[1] + b[3] - 0.01 &&
  b[1] < a[1] + a[3] - 0.01

/**
 * Rects of everything that isn't inside a frame (frames at their grown size), and of each frame's
 * children, checked pairwise within the same container; children stay inside their frame.
 */
function expectNoOverlaps(items: readonly LayoutItem[], placement: Placement): void {
  const rect = (i: LayoutItem): Rect => {
    const [x, y] = placement.positions.get(i.id)!
    const [w, h] = placement.frameSizes.get(i.id) ?? [i.w, i.h]
    return [x, y, w, h]
  }
  for (const container of new Set(items.map((i) => i.parent))) {
    const group = items.filter((i) => i.parent === container)
    group.forEach((a, ix) => {
      for (const b of group.slice(ix + 1)) {
        expect(overlaps(rect(a), rect(b)), `${a.id} overlaps ${b.id}`).toBe(false)
      }
    })
  }
  for (const child of items.filter((i) => i.parent !== null)) {
    const [fx, fy, fw, fh] = rect(items.find((f) => f.id === child.parent)!)
    const [x, y, w, h] = rect(child)
    expect(
      x >= fx && y >= fy && x + w <= fx + fw + 0.01 && y + h <= fy + fh + 0.01,
      `${child.id} leaves its frame`,
    ).toBe(true)
  }
}

function moodboard(): { items: LayoutItem[]; edges: Array<[string, string]> } {
  const items = [
    item('title', 260, 90, { topic: true }),
    item('palette', 240, 150),
    item('type', 260, 180),
  ]
  for (let f = 0; f < 3; f++) {
    const frame = `frame-${f}`
    items.push(item(frame, 300, 200, { frame: true }))
    for (let c = 0; c < 3 + f; c++) {
      const h = 120 + ((c * 37) % 90)
      items.push(item(`${frame}-${c}`, 240, h, { parent: frame }))
    }
  }
  return {
    items,
    edges: [
      ['title', 'frame-0'],
      ['title', 'frame-1-2'],
    ],
  }
}

describe('canvas layout (layout.rs)', () => {
  it('every layout places everything without overlaps', () => {
    const { items, edges } = moodboard()
    for (const layout of ['grid', 'tree', 'flow'] as const) {
      const placement = place(layout, items, edges)
      expect(placement.positions.size, layout).toBe(items.length)
      expectNoOverlaps(items, placement)
    }
  })

  it('tree splits branches around the root', () => {
    const items = [item('root', 240, 84, { topic: true })]
    const edges: Array<[string, string]> = []
    for (let c = 0; c < 5; c++) {
      items.push(item(`c${c}`, 200, 100))
      edges.push(['root', `c${c}`])
      items.push(item(`c${c}-a`, 180, 60))
      edges.push([`c${c}`, `c${c}-a`])
    }
    const placement = place('tree', items, edges)
    expectNoOverlaps(items, placement)
    const rootX = placement.positions.get('root')![0]
    let right = 0
    for (let c = 0; c < 5; c++) if (placement.positions.get(`c${c}`)![0] > rootX) right += 1
    expect(right).toBe(3)
    // Grandchildren sit further out than their parents.
    for (let c = 0; c < 5; c++) {
      const parent = placement.positions.get(`c${c}`)![0]
      const child = placement.positions.get(`c${c}-a`)![0]
      expect(parent > rootX).toBe(child > parent)
    }
  })

  it('flow ranks left to right even with a cycle', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => item(id, 200, 120))
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'b'],
      ['a', 'd'],
    ]
    const placement = place('flow', items, edges)
    expectNoOverlaps(items, placement)
    const x = (id: string): number => placement.positions.get(id)![0]
    expect(x('a')).toBeLessThan(x('b'))
    expect(x('a')).toBeLessThan(x('d'))
  })

  it('packs a frame in two columns from four children and grows it to fit', () => {
    const items = [
      item('f', 330, 220, { frame: true }),
      ...[0, 1, 2, 3].map((c) => item(`f-${c}`, 240, 100, { parent: 'f' })),
    ]
    const placement = place('grid', items, [])
    // 2 columns of 240 with a 16 gap and 16 padding each side; two rows of 100 under the header.
    expect(placement.frameSizes.get('f')).toEqual([
      16 + 240 + 16 + 240 + 16,
      36 + 100 + 16 + 100 + 16,
    ])
    expect(placement.positions.get('f-0')).toEqual([16, 36])
    expect(placement.positions.get('f-1')).toEqual([16 + 240 + 16, 36])
    expect(placement.positions.get('f-2')).toEqual([16, 36 + 116])
  })

  it('grid stacks loose nodes in the first column and wraps frames after four columns', () => {
    const items = [
      item('a', 240, 100),
      item('b', 240, 100),
      ...[0, 1, 2, 3].map((f) => item(`f${f}`, 300, 200, { frame: true })),
    ]
    const placement = place('grid', items, [])
    expect(placement.positions.get('a')).toEqual([0, 0])
    expect(placement.positions.get('b')).toEqual([0, 124])
    expect(placement.positions.get('f0')).toEqual([288, 0])
    // The fifth column (f3) wraps under the tallest of the first row.
    expect(placement.positions.get('f3')).toEqual([0, 224 + 48])
  })

  it('places an empty board without failing and normalizes to the origin', () => {
    expect(place('tree', [], []).positions.size).toBe(0)
    const placement = place('flow', [item('a', 100, 50), item('b', 100, 80)], [])
    const ys = [...placement.positions.values()].map((p) => p[1])
    expect(Math.min(...ys)).toBe(0)
  })
})
