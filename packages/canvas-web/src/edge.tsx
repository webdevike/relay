// A link between two cards with a label pill and a tone. With tidy on (the default) it runs
// orthogonally around every card (route.ts); off, it is the smooth bezier Relay Desktop draws
// (evaos-electron renderer/canvas/CanvasEdge.tsx). An edge naming no handle follows the nodes.
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, type InternalNode, Position, type ReactFlowState, getBezierPath, useInternalNode, useStore } from "@xyflow/react";
import { memo, useEffect } from "react";
import type { CardNode, LinkEdge } from "./model";
import { MARGIN, type Pt, type Rect, type Side, anchor, boundsOf, facingSide, inflate, intersects, roundedPath, routeEdge } from "./route";
import { useTidySetting } from "./useTidy";

const POSITION: Record<Side, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };
const SIDE_INDEX: Record<Side, number> = { left: 0, right: 1, top: 2, bottom: 3 };

function rectOf(node: InternalNode<CardNode>): Rect {
	const { x, y } = node.internals.positionAbsolute;
	return { x, y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 };
}

function sideOf(handle: string | null | undefined): Side | null {
	return handle === "left" || handle === "right" || handle === "top" || handle === "bottom" ? handle : null;
}

// Every drawn card's rect, rebuilt once per change of React Flow's node list (shared by all edges).
let cardsFor: unknown = null;
let cards: Rect[] = [];
function cardRects(s: ReactFlowState): readonly Rect[] {
	if (s.nodes === cardsFor) return cards;
	cardsFor = s.nodes;
	cards = [];
	for (const n of s.nodeLookup.values()) {
		const w = n.measured.width;
		const h = n.measured.height;
		if (!n.hidden && w && h) cards.push({ x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w, h });
	}
	return cards;
}

/**
 * A route and what it was made from: both ends, and every card near the path. A drag elsewhere on
 * the board leaves the key equal, so only the edges a moving card touches route again.
 */
interface Routed {
	key: number[];
	region: Rect;
	path: string;
	mid: Pt;
}

const routes = new Map<string, Routed>();

/** The route's inputs as numbers: ends, sides, and the cards that reach into `region`. */
function routeKey(a: Rect, sSide: Side, b: Rect, tSide: Side, region: Rect, all: readonly Rect[]): number[] {
	const key = [a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h, SIDE_INDEX[sSide], SIDE_INDEX[tSide]];
	for (const r of all) if (intersects(r, region)) key.push(r.x, r.y, r.w, r.h);
	return key;
}

function routed(id: string, a: Rect, sSide: Side, b: Rect, tSide: Side, all: readonly Rect[]): Routed {
	const last = routes.get(id);
	if (last) {
		const key = routeKey(a, sSide, b, tSide, last.region, all);
		if (key.length === last.key.length && key.every((v, i) => v === last.key[i])) return last;
	}
	const pts = routeEdge(a, sSide, b, tSide, all);
	const region = inflate(boundsOf(pts), MARGIN);
	const { path, mid } = roundedPath(pts);
	const next = { key: routeKey(a, sSide, b, tSide, region, all), region, path, mid };
	routes.set(id, next);
	return next;
}

export const CanvasEdge = memo(function CanvasEdge({ id, source, target, sourceHandleId, targetHandleId, data, selected }: EdgeProps<LinkEdge>) {
	const from = useInternalNode<CardNode>(source);
	const to = useInternalNode<CardNode>(target);
	const tidy = useTidySetting();
	const all = useStore(cardRects);
	useEffect(() => () => void routes.delete(id), [id]);
	if (!from || !to) return null;
	const a = rectOf(from);
	const b = rectOf(to);
	const sSide = sideOf(sourceHandleId) ?? facingSide(a, b);
	const tSide = sideOf(targetHandleId) ?? facingSide(b, a);
	let path: string;
	let labelX: number;
	let labelY: number;
	if (tidy) {
		const r = routed(id, a, sSide, b, tSide, all);
		path = r.path;
		[labelX, labelY] = r.mid;
	} else {
		const [sx, sy] = anchor(a, sSide);
		const [tx, ty] = anchor(b, tSide);
		[path, labelX, labelY] = getBezierPath({
			sourceX: sx,
			sourceY: sy,
			sourcePosition: POSITION[sSide],
			targetX: tx,
			targetY: ty,
			targetPosition: POSITION[tSide],
			curvature: 0.25,
		});
	}
	const tone = data?.tone === "accent" || data?.tone === "proposed" || data?.tone === "agent" ? data.tone : "default";
	const lit = selected || from.selected || to.selected;
	return (
		<>
			<BaseEdge id={id} path={path} className={`cv-edge cv-edge-${tone}${lit ? " cv-edge-lit" : ""}`} />
			{data?.label ? (
				<EdgeLabelRenderer>
					<div
						className="cv-edge-label nodrag nopan"
						data-tone={tone}
						data-lit={lit ? "true" : undefined}
						style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
					>
						{data.label}
					</div>
				</EdgeLabelRenderer>
			) : null}
		</>
	);
});
