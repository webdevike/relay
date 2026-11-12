import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  getBezierPath,
  getSmoothStepPath,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react'
import { IconArrowBackUp } from '@tabler/icons-react'
import { memo } from 'react'
import { edgeTone } from './board-model'
import { arrowHead, longestSegmentMid, roundedPath, routeEndsOnSides } from './cards/edge-route'
import type { CardNode, LinkEdge } from './flow-model'

type Side = 'left' | 'right' | 'top' | 'bottom'

const POSITION: Record<Side, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function rectOf(node: InternalNode<CardNode>): Rect {
  const { x, y } = node.internals.positionAbsolute
  return { x, y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 }
}

/** The side of `from` that faces `to`: an edge naming no handle follows the nodes. */
export function facingSide(from: Rect, to: Rect): Side {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

function sideOf(handle: string | null | undefined): Side | null {
  return handle === 'left' || handle === 'right' || handle === 'top' || handle === 'bottom'
    ? handle
    : null
}

function anchor(r: Rect, side: Side): [number, number] {
  switch (side) {
    case 'left':
      return [r.x, r.y + r.h / 2]
    case 'right':
      return [r.x + r.w, r.y + r.h / 2]
    case 'top':
      return [r.x + r.w / 2, r.y]
    case 'bottom':
      return [r.x + r.w / 2, r.y + r.h]
  }
}

/** A smooth bezier between two cards, with a label pill and a tone (cards.rs flow_edge). */
export const CanvasEdge = memo(function CanvasEdge({
  id,
  source,
  target,
  sourceHandleId,
  targetHandleId,
  data,
  selected,
}: EdgeProps<LinkEdge>) {
  const from = useInternalNode<CardNode>(source)
  const to = useInternalNode<CardNode>(target)
  if (!from || !to) return null
  const a = rectOf(from)
  const b = rectOf(to)
  const sSide = sideOf(sourceHandleId) ?? facingSide(a, b)
  const tSide = sideOf(targetHandleId) ?? facingSide(b, a)
  const [sx, sy] = anchor(a, sSide)
  const [tx, ty] = anchor(b, tSide)
  const route = data?.route
  let path: string
  let labelX: number
  let labelY: number
  // Where the last segment comes from: the arrowhead points along it into the target card.
  let tip = { x: tx, y: ty }
  let before = {
    x: tx + (tSide === 'left' ? -1 : tSide === 'right' ? 1 : 0),
    y: ty + (tSide === 'top' ? -1 : tSide === 'bottom' ? 1 : 0),
  }
  if (route && routeEndsOnSides(route, { ...a, side: sSide }, { ...b, side: tSide })) {
    path = roundedPath(route)
    ;[labelX, labelY] = longestSegmentMid(route)
    tip = route[route.length - 1]!
    before = [...route].reverse().find((p) => p.x !== tip.x || p.y !== tip.y) ?? before
  } else if (sourceHandleId && targetHandleId) {
    ;[path, labelX, labelY] = getSmoothStepPath({
      sourceX: sx,
      sourceY: sy,
      sourcePosition: POSITION[sSide],
      targetX: tx,
      targetY: ty,
      targetPosition: POSITION[tSide],
      borderRadius: 10,
    })
  } else {
    ;[path, labelX, labelY] = getBezierPath({
      sourceX: sx,
      sourceY: sy,
      sourcePosition: POSITION[sSide],
      targetX: tx,
      targetY: ty,
      targetPosition: POSITION[tSide],
      curvature: 0.25,
    })
  }
  const tone = edgeTone(data?.tone) ?? 'default'
  const lit = selected || from.selected || to.selected
  return (
    <>
      <g className="eva-cv-edge-group" data-tone={tone} data-lit={lit ? 'true' : undefined}>
        <BaseEdge id={id} path={path} className={`eva-cv-edge eva-cv-edge-${tone}`} />
        <path className="eva-cv-arrow" d={arrowHead(before, tip)} />
      </g>
      {data?.label !== undefined || tone === 'loop' ? (
        <EdgeLabelRenderer>
          <div
            className="eva-cv-edge-label nodrag nopan"
            data-tone={tone}
            data-lit={lit ? 'true' : undefined}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {tone === 'loop' ? <IconArrowBackUp size={12} stroke={1.75} aria-hidden /> : null}
            {data?.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
})
