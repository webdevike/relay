/**
 * The ELK passes the layout engine runs: one flat graph each (no hierarchy; frames and lanes
 * are laid out inside first and come here as plain blocks). `elk.bundled.js` runs in-thread in
 * Node and in the browser alike, so main and the renderer share it. It is about 2 MB, so it
 * loads on the first layout (its own chunk in the renderer), not with the app.
 */
import type ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api'
import type { LayoutDirection } from './types'
import type { Point } from './geometry'

let elk: Promise<InstanceType<typeof ELK>> | null = null

export interface Block {
  id: string
  w: number
  h: number
}

export interface Link {
  id: string
  source: string
  target: string
}

const ROOT_OPTIONS = { 'elk.padding': '[top=0,left=0,bottom=0,right=0]' }

/** Runs `graph` (children `n<i>` for blocks[i]) and answers each block's top left. */
async function run(
  graph: ElkNode,
  blocks: Block[],
): Promise<{ res: ElkNode; pos: Map<string, Point> }> {
  elk ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default())
  const res = await (await elk).layout(graph)
  const pos = new Map<string, Point>()
  for (const c of res.children ?? [])
    pos.set(blocks[Number(c.id.slice(1))]!.id, { x: c.x ?? 0, y: c.y ?? 0 })
  return { res, pos }
}

/**
 * Layered (Sugiyama) placement with orthogonal routes. Every link gets its own port on the
 * flow sides (east/west for `right`, south/north for `down`), so links leave and enter cards
 * on consistent sides, spread along them. Answers top lefts and each link's route.
 */
export async function elkLayered(
  blocks: Block[],
  links: Link[],
  direction: LayoutDirection,
  spacing: number,
): Promise<{ pos: Map<string, Point>; routes: Map<string, Point[]> }> {
  const out = direction === 'right' ? 'EAST' : 'SOUTH'
  const into = direction === 'right' ? 'WEST' : 'NORTH'
  const ports = new Map<string, ElkPort[]>()
  for (const b of blocks) ports.set(b.id, [])
  const edges: ElkExtendedEdge[] = []
  links.forEach((l, i) => {
    const s = `p${i}s`
    const t = `p${i}t`
    ports
      .get(l.source)
      ?.push({ id: s, width: 0, height: 0, layoutOptions: { 'elk.port.side': out } })
    ports
      .get(l.target)
      ?.push({ id: t, width: 0, height: 0, layoutOptions: { 'elk.port.side': into } })
    edges.push({ id: `e${i}`, sources: [s], targets: [t] })
  })
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...ROOT_OPTIONS,
      'elk.algorithm': 'layered',
      'elk.direction': direction === 'right' ? 'RIGHT' : 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': String(spacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(spacing * 1.5)),
      'elk.spacing.componentComponent': String(Math.round(spacing * 1.5)),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: blocks.map((b, i) => ({
      id: `n${i}`,
      width: b.w,
      height: b.h,
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      ports: ports.get(b.id) ?? [],
    })),
    edges,
  }
  const { res, pos } = await run(graph, blocks)
  const routes = new Map<string, Point[]>()
  for (const e of (res.edges ?? []) as ElkExtendedEdge[]) {
    const s = e.sections?.[0]
    if (!s || e.sections!.length !== 1) continue
    routes.set(links[Number(e.id.slice(1))]!.id, [
      s.startPoint,
      ...(s.bendPoints ?? []),
      s.endPoint,
    ])
  }
  return { pos, routes }
}

/** ELK `radial` or `mrtree` on one tree (links point from the root outward). Top lefts. */
export async function elkTree(
  blocks: Block[],
  links: Link[],
  algorithm: 'radial' | 'mrtree',
  direction: LayoutDirection,
  spacing: number,
): Promise<Map<string, Point>> {
  const index = new Map(blocks.map((b, i) => [b.id, i]))
  const biggest = Math.max(...blocks.map((b) => Math.max(b.w, b.h)))
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...ROOT_OPTIONS,
      'elk.algorithm': algorithm,
      'elk.direction': direction === 'right' ? 'RIGHT' : 'DOWN',
      'elk.spacing.nodeNode': String(spacing),
      ...(algorithm === 'radial'
        ? { 'elk.radial.radius': String(Math.round(biggest + spacing)) }
        : {}),
    },
    children: blocks.map((b, i) => ({ id: `n${i}`, width: b.w, height: b.h })),
    edges: links.map((l, i) => ({
      id: `e${i}`,
      sources: [`n${index.get(l.source)}`],
      targets: [`n${index.get(l.target)}`],
    })),
  }
  return (await run(graph, blocks)).pos
}
