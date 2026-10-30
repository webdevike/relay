// The live Y.Doc as React Flow sees it, and the small pure helpers the cards use. No DOM, no
// provider: tests build a Y.Doc and call these directly.
import type { Edge, Node } from "@xyflow/react";
import * as Y from "yjs";
import { type CanvasLayout, FRAME_DEFAULT_H, FRAME_PAD, type LayoutNode, defaultWidth, estimateHeight, placeUnplaced } from "../../canvas-live/src/layout";
import { NODE_KINDS, type NodeKind, type SessionInfo, type User } from "../../canvas-live/src/shared";

export interface Swatch {
	hex: string;
	name?: string;
}

/** One node as the cards draw it: the doc's fields, flattened, text as strings. */
export interface NodeSnap {
	id: string;
	type: NodeKind;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	parent?: string;
	title: string;
	body: string;
	key?: string;
	status?: string;
	pr?: string;
	src?: string;
	caption?: string;
	url?: string;
	tone?: string;
	colors?: Swatch[];
	font?: string;
	sample?: string;
	/** Data keys the file had: `body` shows when listed even if empty. */
	fields: string[];
}

export interface CardData extends Record<string, unknown> {
	spec: NodeSnap;
	/** A frame holding nodes (no wireframe then). */
	hasChildren: boolean;
}
export type CardNode = Node<CardData, "card">;

export interface LinkData extends Record<string, unknown> {
	label?: string;
	tone?: string;
}
export type LinkEdge = Edge<LinkData, "link">;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const nodeParent = (m: Y.Map<unknown> | undefined): string | undefined => {
	const p = m?.get("parent");
	return typeof p === "string" ? p : undefined;
};

/** A node as drawn: absolute top-left and size. */
export interface FlowBox {
	id: string;
	type: NodeKind;
	x: number;
	y: number;
	w: number;
	h: number;
}

/** True when `id` is `ancestor` or sits at any depth inside it. */
function isUnder(yNodes: Y.Map<Y.Map<unknown>>, id: string, ancestor: string): boolean {
	const seen = new Set<string>();
	for (let cur: string | undefined = id; cur !== undefined && !seen.has(cur); cur = nodeParent(yNodes.get(cur))) {
		if (cur === ancestor) return true;
		seen.add(cur);
	}
	return false;
}

/**
 * The frame a dropped node belongs to: the smallest other frame whose area holds the node's
 * center (and is larger than the node, never one of its own descendants), else null.
 */
export function frameForDrop(boxes: readonly FlowBox[], id: string, yNodes: Y.Map<Y.Map<unknown>>): string | null {
	const b = boxes.find((x) => x.id === id);
	if (!b) return null;
	const cx = b.x + b.w / 2;
	const cy = b.y + b.h / 2;
	let best: string | null = null;
	let bestArea = Number.POSITIVE_INFINITY;
	for (const f of boxes) {
		if (f.id === id || f.type !== "frame") continue;
		const area = f.w * f.h;
		if (area <= b.w * b.h || area >= bestArea) continue;
		if (cx < f.x || cy < f.y || cx > f.x + f.w || cy > f.y + f.h) continue;
		if (isUnder(yNodes, f.id, id)) continue;
		best = f.id;
		bestArea = area;
	}
	return best;
}

/** Sets each dropped node's `parent` from where it landed; coordinates stay absolute. Returns the ids that changed. */
export function reparentDropped(yNodes: Y.Map<Y.Map<unknown>>, boxes: readonly FlowBox[], ids: readonly string[]): string[] {
	const moved = new Set(ids);
	const changed: string[] = [];
	for (const id of ids) {
		const m = yNodes.get(id);
		if (!m) continue;
		const p = nodeParent(m);
		// A child that travels with its selected frame has not changed frames.
		if (p !== undefined && moved.has(p)) continue;
		const next = frameForDrop(boxes, id, yNodes);
		if ((next ?? undefined) === p) continue;
		if (next === null) m.delete("parent");
		else m.set("parent", next);
		changed.push(id);
	}
	return changed;
}

const GROUP_PAD = 40;
const GROUP_TOP = 56;

/** Wraps the selected nodes in a new frame. Returns its id, or null when there is nothing to group. */
export function groupNodes(yNodes: Y.Map<Y.Map<unknown>>, boxes: readonly FlowBox[], ids: readonly string[], newId: string, title = "Group"): string | null {
	const picked = boxes.filter((b) => ids.includes(b.id) && yNodes.has(b.id));
	if (picked.length === 0 || yNodes.has(newId)) return null;
	const x = Math.min(...picked.map((b) => b.x)) - GROUP_PAD;
	const y = Math.min(...picked.map((b) => b.y)) - GROUP_TOP;
	const w = Math.max(...picked.map((b) => b.x + b.w)) + GROUP_PAD - x;
	const h = Math.max(...picked.map((b) => b.y + b.h)) + GROUP_PAD - y;
	const f = new Y.Map<unknown>();
	f.set("type", "frame");
	f.set("x", Math.round(x));
	f.set("y", Math.round(y));
	f.set("w", Math.round(w));
	f.set("h", Math.round(h));
	f.set("title", new Y.Text(title));
	f.set("body", new Y.Text(""));
	f.set("fields", []);
	// The new frame sits where the selection did: in their shared frame, if they have one.
	const parents = new Set(picked.map((b) => nodeParent(yNodes.get(b.id))));
	const shared = parents.size === 1 ? [...parents][0] : undefined;
	if (shared !== undefined && !ids.includes(shared)) f.set("parent", shared);
	yNodes.set(newId, f);
	const chosen = new Set(picked.map((b) => b.id));
	for (const b of picked) {
		const p = nodeParent(yNodes.get(b.id));
		if (p !== undefined && chosen.has(p)) continue;
		yNodes.get(b.id)?.set("parent", newId);
	}
	return newId;
}

/** Deletes the frames and hands their children to the frame's own parent (or none). Returns the freed ids. */
export function ungroupFrames(yNodes: Y.Map<Y.Map<unknown>>, frameIds: readonly string[]): string[] {
	const freed: string[] = [];
	for (const fid of frameIds) {
		const f = yNodes.get(fid);
		if (!f || f.get("type") !== "frame") continue;
		const up = nodeParent(f);
		for (const [id, m] of yNodes) {
			if (nodeParent(m) !== fid) continue;
			if (up !== undefined && up !== fid) m.set("parent", up);
			else m.delete("parent");
			freed.push(id);
		}
		yNodes.delete(fid);
	}
	return freed;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : v instanceof Y.Text ? v.toString() : undefined);

function swatches(v: unknown): Swatch[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: Swatch[] = [];
	for (const s of v as unknown[]) {
		if (!s || typeof s !== "object" || !("hex" in s) || typeof s.hex !== "string") continue;
		out.push("name" in s && typeof s.name === "string" ? { hex: s.hex, name: s.name } : { hex: s.hex });
	}
	return out;
}

export function nodeKind(v: unknown): NodeKind {
	return NODE_KINDS.find((k) => k === v) ?? "note";
}

/** Plain string data keys copied from the node map when present. */
const PLAIN = ["key", "status", "pr", "src", "caption", "url", "tone", "font", "sample"] as const;

export function snapNode(id: string, m: Y.Map<unknown>): NodeSnap {
	const fields = m.get("fields");
	const snap: NodeSnap = {
		id,
		type: nodeKind(m.get("type")),
		title: str(m.get("title")) ?? "",
		body: str(m.get("body")) ?? "",
		fields: Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [],
	};
	const x = num(m.get("x"));
	const y = num(m.get("y"));
	const w = num(m.get("w"));
	const h = num(m.get("h"));
	const parent = str(m.get("parent"));
	if (x !== undefined) snap.x = x;
	if (y !== undefined) snap.y = y;
	if (w !== undefined) snap.w = w;
	if (h !== undefined) snap.h = h;
	if (parent) snap.parent = parent;
	for (const k of PLAIN) {
		const v = str(m.get(k));
		if (v !== undefined) snap[k] = v;
	}
	const colors = swatches(m.get("colors"));
	if (colors) snap.colors = colors;
	return snap;
}

export function snapNodes(nodes: Y.Map<Y.Map<unknown>>): NodeSnap[] {
	const out: NodeSnap[] = [];
	for (const [id, m] of nodes) if (m instanceof Y.Map) out.push(snapNode(id, m));
	return out;
}

function layoutNode(s: NodeSnap): LayoutNode {
	const n: LayoutNode = { id: s.id, type: s.type, title: s.title, body: s.body };
	if (s.x !== undefined) n.x = s.x;
	if (s.y !== undefined) n.y = s.y;
	if (s.w !== undefined) n.w = s.w;
	if (s.h !== undefined) n.h = s.h;
	if (s.parent !== undefined) n.parent = s.parent;
	if (s.caption !== undefined) n.caption = s.caption;
	if (s.sample !== undefined) n.sample = s.sample;
	if (s.colors !== undefined) n.colors = s.colors;
	return n;
}

/** The frame `spec` sits in, when that is an existing frame and the chain has no cycle. */
function parentOf(spec: NodeSnap, byId: ReadonlyMap<string, NodeSnap>): string | undefined {
	const p = spec.parent;
	if (p === undefined || p === spec.id || byId.get(p)?.type !== "frame") return undefined;
	const seen = new Set([spec.id]);
	let cur: string | undefined = p;
	while (cur !== undefined) {
		if (seen.has(cur)) return undefined;
		seen.add(cur);
		const up: NodeSnap | undefined = byId.get(cur);
		cur = up?.parent !== undefined && byId.get(up.parent)?.type === "frame" ? up.parent : undefined;
	}
	return p;
}

export interface FlowInput {
	nodes: readonly NodeSnap[];
	edges: readonly { source: string; target: string }[];
	layout?: CanvasLayout | undefined;
	/** Drawn sizes, so placement of unplaced nodes uses real heights. */
	measured?: ReadonlyMap<string, { w: number; h: number }>;
}

/** Absolute top-left of every node: its own x/y, else where the board layout puts it. */
export function absolutePositions(input: FlowInput): Map<string, { x: number; y: number }> {
	const at = new Map<string, { x: number; y: number }>();
	const missing = input.nodes.some((n) => n.x === undefined || n.y === undefined);
	const placed = missing ? placeUnplaced(input.nodes.map(layoutNode), input.edges, input.layout, input.measured) : new Map<string, { x: number; y: number }>();
	for (const n of input.nodes) {
		const p = n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : placed.get(n.id);
		at.set(n.id, p ?? { x: 0, y: 0 });
	}
	return at;
}

/**
 * React Flow nodes, parents before children (React Flow needs that), positions relative to the
 * parent frame. A node whose spec did not change keeps its previous object, so React Flow's
 * measured size and selection survive and memoized cards skip rendering.
 */
export function toFlowNodes(input: FlowInput, prev: readonly CardNode[] = []): CardNode[] {
	const byId = new Map(input.nodes.map((s) => [s.id, s]));
	const prevById = new Map(prev.map((n) => [n.id, n]));
	const parent = new Map<string, string>();
	for (const s of input.nodes) {
		const p = parentOf(s, byId);
		if (p !== undefined) parent.set(s.id, p);
	}
	const withChildren = new Set(parent.values());
	const depth = (id: string): number => {
		let d = 0;
		for (let p = parent.get(id); p !== undefined; p = parent.get(p)) d += 1;
		return d;
	};
	const at = absolutePositions(input);
	const ranked = input.nodes.map((spec, rank) => ({ spec, rank, depth: depth(spec.id) }));
	ranked.sort((a, b) => a.depth - b.depth || a.rank - b.rank);
	// Sizes as drawn: the file's, else default width and drawn (or estimated) height. A frame grows
	// to hold its children, deepest frames first, so a nested frame's growth reaches its parent.
	const size = new Map<string, { w: number; h: number }>();
	for (const { spec } of ranked) {
		const w = spec.w ?? defaultWidth(spec.type);
		const drawn = input.measured?.get(spec.id);
		size.set(spec.id, { w, h: spec.type === "frame" ? (spec.h ?? FRAME_DEFAULT_H) : (spec.h ?? drawn?.h ?? estimateHeight(layoutNode(spec), w)) });
	}
	for (let i = ranked.length - 1; i >= 0; i--) {
		const id = ranked[i]?.spec.id;
		const p = id !== undefined ? parent.get(id) : undefined;
		if (id === undefined || p === undefined) continue;
		const c = at.get(id);
		const cs = size.get(id);
		const pa = at.get(p);
		const ps = size.get(p);
		if (!c || !cs || !pa || !ps) continue;
		ps.w = Math.max(ps.w, c.x + cs.w + FRAME_PAD - pa.x);
		ps.h = Math.max(ps.h, c.y + cs.h + FRAME_PAD - pa.y);
	}
	return ranked.map(({ spec }) => {
		const abs = at.get(spec.id) ?? { x: 0, y: 0 };
		const p = parent.get(spec.id);
		const pAbs = p !== undefined ? (at.get(p) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
		const position = { x: abs.x - pAbs.x, y: abs.y - pAbs.y };
		const frame = spec.type === "frame";
		const grown = size.get(spec.id);
		const width = frame && grown ? grown.w : (spec.w ?? defaultWidth(spec.type));
		const height = frame ? grown?.h : spec.h;
		const hasChildren = withChildren.has(spec.id);
		const old = prevById.get(spec.id);
		const sameData = old && old.data.hasChildren === hasChildren && JSON.stringify(old.data.spec) === JSON.stringify(spec);
		const node: CardNode = {
			...old,
			id: spec.id,
			type: "card",
			position: old && old.position.x === position.x && old.position.y === position.y ? old.position : position,
			data: sameData ? old.data : { spec, hasChildren },
			width,
			zIndex: frame ? -1 : 0,
		};
		if (height !== undefined) node.height = height;
		else delete node.height;
		if (p !== undefined) {
			node.parentId = p;
			node.expandParent = true;
		} else {
			delete node.parentId;
			delete node.expandParent;
		}
		if (old && sameData && old.position === node.position && old.width === width && old.height === node.height && old.parentId === node.parentId) return old;
		return node;
	});
}

export interface EdgeSnap {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
	label?: string;
	tone?: string;
}

export function snapEdges(edges: Y.Map<Y.Map<unknown>>): EdgeSnap[] {
	const out: EdgeSnap[] = [];
	for (const [id, m] of edges) {
		if (!(m instanceof Y.Map)) continue;
		const source = str(m.get("source"));
		const target = str(m.get("target"));
		if (!source || !target) continue;
		const e: EdgeSnap = { id, source, target };
		const sh = str(m.get("sourceHandle"));
		const th = str(m.get("targetHandle"));
		const label = str(m.get("label"));
		const tone = str(m.get("tone"));
		if (sh) e.sourceHandle = sh;
		if (th) e.targetHandle = th;
		if (label) e.label = label;
		if (tone) e.tone = tone;
		out.push(e);
	}
	return out;
}

/** Edges whose two ends exist, as React Flow `link` edges. */
export function toFlowEdges(edges: readonly EdgeSnap[], nodeIds: ReadonlySet<string>): LinkEdge[] {
	const out: LinkEdge[] = [];
	for (const e of edges) {
		if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
		const data: LinkData = {};
		if (e.label !== undefined) data.label = e.label;
		if (e.tone !== undefined) data.tone = e.tone;
		const edge: LinkEdge = { id: e.id, source: e.source, target: e.target, type: "link", data };
		if (e.sourceHandle) edge.sourceHandle = e.sourceHandle;
		if (e.targetHandle) edge.targetHandle = e.targetHandle;
		out.push(edge);
	}
	return out;
}

export const TONES = ["accent", "warn", "danger", "success", "muted"] as const;
export type Tone = (typeof TONES)[number];

/** A color role by name, else `fallback`. */
export function tone(name: string | undefined, fallback: Tone): Tone {
	return TONES.find((t) => t === name) ?? fallback;
}

/** A link's host for its button, `dribbble.com` for `https://www.dribbble.com/shots/…`. */
export function host(url: string): string {
	const rest = url.includes("://") ? (url.split("://")[1] ?? url) : url;
	const h = rest.split("/")[0] ?? rest;
	return h.startsWith("www.") ? h.slice(4) : h;
}

/** `#RRGGBB` or `#RRGGBBAA`, else null. */
export function swatchColor(hex: string): string | null {
	const digits = hex.trim().replace(/^#/, "");
	return /^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(digits) ? `#${digits}` : null;
}

/** Minimal prefix/suffix diff, so a textarea edit becomes one CRDT op that merges with the agent's typing. */
export function applyDiff(yt: Y.Text, next: string): void {
	const prev = yt.toString();
	let s = 0;
	while (s < prev.length && s < next.length && prev[s] === next[s]) s++;
	let e = 0;
	while (e < prev.length - s && e < next.length - s && prev[prev.length - 1 - e] === next[next.length - 1 - e]) e++;
	const del = prev.length - s - e;
	const ins = next.slice(s, next.length - e);
	const run = () => {
		if (del > 0) yt.delete(s, del);
		if (ins) yt.insert(s, ins);
	};
	if (yt.doc) yt.doc.transact(run);
	else run();
}

/** The agent in the room: the session's, else the one `/me` named, else whoever is present as an agent. */
export function roomAgent(session: unknown, me: Pick<User, "name" | "color" | "avatar"> | null, present: Iterable<User>): Pick<User, "name" | "color" | "avatar"> | null {
	if (session && typeof session === "object" && "agent" in session) {
		const a = (session as SessionInfo).agent;
		if (a && typeof a.name === "string") return a;
	}
	if (me) return me;
	for (const u of present) if (u.kind === "agent") return u;
	// Spike rooms keep only the assistant's name in the session.
	if (session && typeof session === "object" && "assistant" in session && typeof session.assistant === "string") return { name: session.assistant, color: "#8b5cf6" };
	return null;
}

/** A name nobody else in the room has: "Isaac", then "Isaac 2", "Isaac 3". */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name)) return name;
	let i = 2;
	while (taken.has(`${name} ${i}`)) i++;
	return `${name} ${i}`;
}

/** Colors for humans; orange and violet stay with agents. */
export const HUMAN_COLORS = ["#0ea5e9", "#16a34a", "#e11d48", "#ca8a04", "#db2777", "#0d9488"];

/** `color` unless someone has it, then the first free palette color. */
export function freeColor(color: string, taken: ReadonlySet<string>): string {
	if (!taken.has(color)) return color;
	return HUMAN_COLORS.find((c) => !taken.has(c)) ?? color;
}
