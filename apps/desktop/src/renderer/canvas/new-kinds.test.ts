import type { CanvasNode } from '@evaos/contract'
import { describe, expect, it } from 'vitest'
import { defaultWidth, edgeTone, estimateHeight } from './board-model'
import { toBoard, toFlowEdges } from './flow-model'

const node = (type: CanvasNode['type'], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id: 'n',
  type,
  ...extra,
})

describe('step and explainer sizes', () => {
  it('sizes a step', () => {
    expect(defaultWidth('step')).toBe(300)
    expect(estimateHeight(node('step'), 300)).toBe(64)
    // 44 chars per line at width 300: 88 chars is two lines, a newline starts another.
    expect(estimateHeight(node('step', { data: { body: 'x'.repeat(88) } }), 300)).toBe(64 + 36)
    expect(estimateHeight(node('step', { data: { body: 'x'.repeat(44) + '\nyy' } }), 300)).toBe(
      64 + 36,
    )
    expect(estimateHeight(node('step', { h: 120 }), 300)).toBe(120)
  })

  it('estimates an explainer from text, picture, diagram and footer', () => {
    expect(defaultWidth('explainer')).toBe(380)
    expect(estimateHeight(node('explainer'), 380)).toBe(56)
    // 104 chars at 52 per line is two lines.
    const body = 'x'.repeat(104)
    expect(estimateHeight(node('explainer', { data: { body } }), 380)).toBe(56 + 40)
    // List lines count one each.
    expect(estimateHeight(node('explainer', { data: { body: '- a\n- b\n- c' } }), 380)).toBe(
      56 + 60,
    )
    expect(
      estimateHeight(
        node('explainer', { data: { body, src: 'a.png', mermaid: 'graph TD', why: 'y' } }),
        380,
      ),
    ).toBe(56 + 40 + 168 + 228 + 36 + 20)
  })
})

describe('edge tones and routes', () => {
  it('accepts the new tones and drops unknown ones', () => {
    for (const t of ['accent', 'proposed', 'loop', 'success', 'danger', 'muted'])
      expect(edgeTone(t)).toBe(t)
    expect(edgeTone('pink')).toBeUndefined()
  })

  it('carries a route through the flow edge and back to the file', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]
    const edges = toFlowEdges([{ id: 'a-b', source: 'a', target: 'b', tone: 'loop', route }])
    expect(edges[0]!.data).toEqual({ tone: 'loop', route })
    const board = toBoard({ title: 't', layout: undefined, nodes: [], edges }, null)
    expect(board.edges[0]).toEqual({ id: 'a-b', source: 'a', target: 'b', tone: 'loop', route })
  })
})
