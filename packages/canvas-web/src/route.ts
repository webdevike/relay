// Orthogonal edge routing around cards. Pure: edge.tsx calls `routeEdge` with every card's drawn
// rect and draws the result with rounded corners.
//
// The path leaves the source side straight out (a short stub), then runs on a sparse grid made of
// the stub ends and every nearby card's edges pushed out by `MARGIN`, and A* picks the shortest
// way that never enters a card, with a cost per bend so it prefers few turns. Cards only enter the
// grid when they lie near the straight route; when the answer still crosses a card further out,
// the search runs again over every card.

export type Side = "left" | "right" | "top" | "bottom";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type Pt = readonly [number, number];

/** Clearance kept between a path and any card; under half the tidy gap, so a path fits between two cards. */
export const MARGIN = 10;
/**
 * How far a path runs straight out of its card before it may turn: past its own margin but short
 * of a neighbor's, so it can leave a card that sits the tidy gap (24) from the next one.
 */
const STUB = 12;
/** Cost of a turn, in flow units of length. */
const BEND = 24;
/** Cards within this distance of the stub ends' box shape the first search. */
const NEAR = 160;

const DIRS: readonly Pt[] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];
const SIDE_DIR: Record<Side, number> = { right: 0, left: 1, bottom: 2, top: 3 };
const OPPOSITE = [1, 0, 3, 2];

/** The side of `from` that faces `to`. */
export function facingSide(from: Rect, to: Rect): Side {
	const dx = to.x + to.w / 2 - (from.x + from.w / 2);
	const dy = to.y + to.h / 2 - (from.y + from.h / 2);
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
	return dy >= 0 ? "bottom" : "top";
}

/** The middle of `r`'s `side`. */
export function anchor(r: Rect, side: Side): Pt {
	switch (side) {
		case "left":
			return [r.x, r.y + r.h / 2];
		case "right":
			return [r.x + r.w, r.y + r.h / 2];
		case "top":
			return [r.x + r.w / 2, r.y];
		case "bottom":
			return [r.x + r.w / 2, r.y + r.h];
	}
}

/** `r` grown by `by` on every side. */
export function inflate(r: Rect, by: number): Rect {
	return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

/** How far `p` is outside `r` along the axis it is furthest out on; 0 or less when inside. */
function clearance(r: Rect, p: Pt): number {
	return Math.max(r.x - p[0], p[0] - r.x - r.w, r.y - p[1], p[1] - r.y - r.h);
}

/** Whether two rects overlap (touching borders do not). */
export function intersects(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The bounding box of `pts`. */
export function boundsOf(pts: readonly Pt[]): Rect {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const [x, y] of pts) {
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Whether the axis-aligned segment a-b passes through the inside of `r`. */
function crossesRect(a: Pt, b: Pt, r: Rect): boolean {
	if (a[1] === b[1]) {
		const y = a[1];
		if (!(y > r.y && y < r.y + r.h)) return false;
		return Math.min(a[0], b[0]) < r.x + r.w && Math.max(a[0], b[0]) > r.x;
	}
	const x = a[0];
	if (!(x > r.x && x < r.x + r.w)) return false;
	return Math.min(a[1], b[1]) < r.y + r.h && Math.max(a[1], b[1]) > r.y;
}

/** Whether the polyline `pts` passes through the inside of any of `rects`. */
export function crossesAny(pts: readonly Pt[], rects: readonly Rect[]): boolean {
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1] as Pt;
		const b = pts[i] as Pt;
		for (const r of rects) if (crossesRect(a, b, r)) return true;
	}
	return false;
}

/** Sorted distinct values. */
function axis(values: number[]): number[] {
	values.sort((a, b) => a - b);
	const out: number[] = [];
	for (const v of values) if (out.length === 0 || v - (out[out.length - 1] as number) > 0.5) out.push(v);
	return out;
}

/** Binary min-heap of grid states keyed by their estimated total cost. */
class Heap {
	private readonly keys: number[] = [];
	private readonly vals: number[] = [];
	get size(): number {
		return this.vals.length;
	}
	push(key: number, val: number): void {
		const k = this.keys;
		const v = this.vals;
		let i = v.length;
		k.push(key);
		v.push(val);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if ((k[p] as number) <= key) break;
			k[i] = k[p] as number;
			v[i] = v[p] as number;
			i = p;
		}
		k[i] = key;
		v[i] = val;
	}
	pop(): number {
		const k = this.keys;
		const v = this.vals;
		const top = v[0] as number;
		const lastK = k.pop() as number;
		const lastV = v.pop() as number;
		const n = v.length;
		if (n > 0) {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				if (l >= n) break;
				const r = l + 1;
				const c = r < n && (k[r] as number) < (k[l] as number) ? r : l;
				if ((k[c] as number) >= lastK) break;
				k[i] = k[c] as number;
				v[i] = v[c] as number;
				i = c;
			}
			k[i] = lastK;
			v[i] = lastV;
		}
		return top;
	}
}

/**
 * A* over the grid of `obstacles`' borders (already inflated) from `s` leaving in direction
 * `sDir` to `t`, arriving best in direction `tDir`. The polyline from `s` to `t`, or null.
 */
function search(s: Pt, sDir: number, t: Pt, tDir: number, obstacles: readonly Rect[]): Pt[] | null {
	const xv = [s[0], t[0], (s[0] + t[0]) / 2];
	const yv = [s[1], t[1], (s[1] + t[1]) / 2];
	for (const r of obstacles) {
		xv.push(r.x, r.x + r.w);
		yv.push(r.y, r.y + r.h);
	}
	const xs = axis(xv);
	const ys = axis(yv);
	const nx = xs.length;
	const ny = ys.length;
	const at = (vals: number[], v: number) => vals.findIndex((u) => Math.abs(u - v) <= 0.5);
	const si = at(xs, s[0]) * ny + at(ys, s[1]);
	const ti = at(xs, t[0]) * ny + at(ys, t[1]);
	const tx = t[0];
	const ty = t[1];
	// Points inside a card are never visited; the grid holds every border, so a step between two
	// neighboring grid points crosses a card exactly when its midpoint is inside one.
	const free = (x: number, y: number) => {
		for (const r of obstacles) if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return false;
		return true;
	};
	const n = nx * ny;
	const cost = new Float64Array(n * 4).fill(Infinity);
	const from = new Int32Array(n * 4).fill(-1);
	const heap = new Heap();
	const start = si * 4 + sDir;
	cost[start] = 0;
	heap.push(Math.abs(s[0] - tx) + Math.abs(s[1] - ty), start);
	while (heap.size > 0) {
		const state = heap.pop();
		const node = state >> 2;
		const dir = state & 3;
		const g = cost[state] as number;
		if (node === ti) {
			const pts: Pt[] = [];
			for (let st = state; st !== -1; st = from[st] as number) {
				const p = st >> 2;
				pts.push([xs[Math.floor(p / ny)] as number, ys[p % ny] as number]);
			}
			return pts.reverse();
		}
		const i = Math.floor(node / ny);
		const j = node % ny;
		const x = xs[i] as number;
		const y = ys[j] as number;
		for (let d = 0; d < 4; d++) {
			if (d === OPPOSITE[dir]) continue;
			const [dx, dy] = DIRS[d] as Pt;
			const ni = i + dx;
			const nj = j + dy;
			if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue;
			const x2 = xs[ni] as number;
			const y2 = ys[nj] as number;
			if (!free((x + x2) / 2, (y + y2) / 2)) continue;
			const next = ni * ny + nj;
			if (next !== ti && !free(x2, y2)) continue;
			let step = g + Math.abs(x2 - x) + Math.abs(y2 - y) + (d === dir ? 0 : BEND);
			if (next === ti && d !== tDir) step += BEND;
			const ns = next * 4 + d;
			if (step >= (cost[ns] as number)) continue;
			cost[ns] = step;
			from[ns] = state;
			heap.push(step + Math.abs(x2 - tx) + Math.abs(y2 - ty), ns);
		}
	}
	return null;
}

/** Drops repeated points and the middle of straight runs. */
function simplify(pts: readonly Pt[]): Pt[] {
	const out: Pt[] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
		const prev = out[out.length - 2];
		if (prev && last && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) out[out.length - 1] = p;
		else out.push(p);
	}
	return out;
}

/**
 * The orthogonal path from the middle of `a`'s `sSide` to the middle of `b`'s `tSide` that keeps
 * `MARGIN` clear of every rect in `cards` (which may include `a` and `b`).
 */
export function routeEdge(a: Rect, sSide: Side, b: Rect, tSide: Side, cards: readonly Rect[]): Pt[] {
	const s0 = anchor(a, sSide);
	const t0 = anchor(b, tSide);
	const sDir = SIDE_DIR[sSide];
	const tOut = SIDE_DIR[tSide];
	const [sdx, sdy] = DIRS[sDir] as Pt;
	const [tdx, tdy] = DIRS[tOut] as Pt;
	const s1: Pt = [s0[0] + sdx * STUB, s0[1] + sdy * STUB];
	const t1: Pt = [t0[0] + tdx * STUB, t0[1] + tdy * STUB];
	// Each card keeps `MARGIN` of clearance, less when a stub end sits closer to it (cards packed
	// tighter than the margin), so the path can still leave between them. A card that holds a stub
	// end (a frame around the node) cannot be avoided, so it is no obstacle for this edge.
	const blocks: Rect[] = [];
	for (const r of cards) {
		const room = Math.min(clearance(r, s1), clearance(r, t1));
		if (room > 0) blocks.push(inflate(r, Math.min(MARGIN, room)));
	}
	const tDir = OPPOSITE[tOut] as number;
	const near = inflate(boundsOf([s1, t1]), NEAR);
	let mid = search(s1, sDir, t1, tDir, blocks.filter((r) => intersects(r, near)));
	if (!mid || crossesAny(mid, blocks)) mid = search(s1, sDir, t1, tDir, blocks) ?? mid;
	return simplify([s0, ...(mid ?? [s1, [s1[0], t1[1]], t1]), t0]);
}

/** SVG path through `pts` with corners rounded by up to `radius`, and the point halfway along it. */
export function roundedPath(pts: readonly Pt[], radius = 10): { path: string; mid: Pt } {
	const first = pts[0];
	if (!first) return { path: "", mid: [0, 0] };
	let d = `M${first[0]},${first[1]}`;
	let total = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1] as Pt;
		const b = pts[i] as Pt;
		total += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
	}
	for (let i = 1; i < pts.length - 1; i++) {
		const p = pts[i - 1] as Pt;
		const c = pts[i] as Pt;
		const n = pts[i + 1] as Pt;
		const inLen = Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]);
		const outLen = Math.abs(n[0] - c[0]) + Math.abs(n[1] - c[1]);
		const r = Math.min(radius, inLen / 2, outLen / 2);
		const ix = Math.sign(c[0] - p[0]);
		const iy = Math.sign(c[1] - p[1]);
		const ox = Math.sign(n[0] - c[0]);
		const oy = Math.sign(n[1] - c[1]);
		d += ` L${c[0] - ix * r},${c[1] - iy * r} Q${c[0]},${c[1]} ${c[0] + ox * r},${c[1] + oy * r}`;
	}
	const last = pts[pts.length - 1] as Pt;
	d += ` L${last[0]},${last[1]}`;
	let left = total / 2;
	let mid: Pt = first;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1] as Pt;
		const b = pts[i] as Pt;
		const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
		if (len >= left) {
			const t = len === 0 ? 0 : left / len;
			mid = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
			break;
		}
		left -= len;
	}
	return { path: d, mid };
}
