// When tidy runs and how its moves reach the doc. Each change is tidied in one place, so clients
// never fight over a card: a drop by the client that dropped it, the moment it lands; everything
// no client owns (the agent's edits, a card growing as its image loads or its text changes,
// drops from clients without tidy) by the leader, the lowest human client that tidies, once the
// board has been still for a moment.
import { type NodeChange, type OnNodeDrag, useStoreApi } from "@xyflow/react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import type { CardNode, LinkEdge } from "./model";
import { awareness, doc, presenceStates, subscribePresence, yNodes, ySettings } from "./room";
import { type Box, separate, tidyLeader } from "./tidy";

/** Transaction origin of tidy's own moves, so they don't wake the leader again. */
const TIDY_ORIGIN = "tidy";
/** How long the board stays still before the leader tidies (a remote drag keeps writing). */
const SETTLE_MS = 300;
/** Node keys whose change can make a card overlap another. */
const GEOMETRY = new Set(["x", "y", "w", "h", "parent", "type"]);

/** The board's tidy setting: on unless `settings.tidy` is false. */
export function tidyOn(): boolean {
	return ySettings.get("tidy") !== false;
}

function subscribeSettings(cb: () => void): () => void {
	ySettings.observe(cb);
	return () => ySettings.unobserve(cb);
}

export function useTidySetting(): boolean {
	return useSyncExternalStore(subscribeSettings, tidyOn);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface Tidy {
	onNodeDragStart: OnNodeDrag<CardNode>;
	/** Tidies around the dropped cards right away (this client owns the drop). */
	onNodeDragStop: OnNodeDrag<CardNode>;
	/** Feed React Flow's node changes: cards whose drawn size changed get tidied around. */
	sizesChanged(changes: readonly NodeChange<CardNode>[]): void;
	/** Watches the doc, setting and presence; returns the unsubscribe. */
	subscribe(): () => void;
}

export function useTidy(): Tidy {
	const store = useStoreApi<CardNode, LinkEdge>();
	const tidy = useMemo((): Tidy => {
		const pending = new Set<string>();
		let timer = 0;
		let dragging = false;
		/** Each card's last drawn size, rounded, to tell growth from a first measure. */
		const sizes = new Map<string, { w: number; h: number }>();

		/** Pushes cards out of each other, `anchors` staying put where they can, and writes the moves. */
		const run = (anchors: ReadonlySet<string>) => {
			if (!tidyOn()) return;
			const lookup = store.getState().nodeLookup;
			// Positions from the doc (current even before React Flow re-renders), drawn sizes from
			// React Flow. A card without a position belongs to the board layout: others give way to it.
			const at = new Map<string, { x: number; y: number }>();
			const boxes: Box[] = [];
			for (const [id, n] of lookup) {
				const m = yNodes.get(id);
				if (!m) continue;
				const x = m.get("x");
				const y = m.get("y");
				const placed = isNum(x) && isNum(y);
				const p = placed ? { x, y } : n.internals.positionAbsolute;
				if (placed) at.set(id, p);
				const { width: w, height: h } = n.measured;
				if (w && h) boxes.push({ id, group: n.parentId ?? "", x: p.x, y: p.y, w, h, fixed: !placed });
			}
			const moves = separate(boxes, anchors);
			if (moves.size === 0) return;
			const shifts = new Map<string, { dx: number; dy: number }>();
			for (const [id, p] of moves) {
				const was = at.get(id);
				if (was) shifts.set(id, { dx: p.x - was.x, dy: p.y - was.y });
			}
			doc.transact(() => {
				// The file keeps absolute positions: a frame's cards move with it.
				for (const [id, p] of at) {
					let dx = 0;
					let dy = 0;
					for (let cur: string | undefined = id, guard = 0; cur !== undefined && guard < 64; cur = lookup.get(cur)?.parentId, guard++) {
						const s = shifts.get(cur);
						if (s) {
							dx += s.dx;
							dy += s.dy;
						}
					}
					if (dx === 0 && dy === 0) continue;
					const m = yNodes.get(id);
					m?.set("x", Math.round(p.x + dx));
					m?.set("y", Math.round(p.y + dy));
				}
			}, TIDY_ORIGIN);
		};

		const flush = () => {
			timer = 0;
			if (dragging) {
				timer = window.setTimeout(flush, SETTLE_MS);
				return;
			}
			const anchors = new Set(pending);
			pending.clear();
			run(anchors);
		};

		/** On the leader, tidies once the board settles, `ids` staying put where they can. */
		const schedule = (ids: Iterable<string>) => {
			if (!tidyOn() || awareness.getLocalState() === null || tidyLeader(presenceStates()) !== awareness.clientID) return;
			for (const id of ids) pending.add(id);
			window.clearTimeout(timer);
			timer = window.setTimeout(flush, SETTLE_MS);
		};

		const onDoc = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => {
			if (tr.origin === TIDY_ORIGIN) return;
			const ids: string[] = [];
			for (const e of events) {
				if (e.target === yNodes) {
					for (const [id, change] of e.changes.keys) if (change.action !== "delete") ids.push(id);
				} else if (e.path.length === 1 && [...e.changes.keys.keys()].some((k) => GEOMETRY.has(k))) ids.push(String(e.path[0]));
			}
			if (ids.length > 0) schedule(ids);
		};

		let leading = false;
		const onPresence = () => {
			const now = tidyLeader(presenceStates()) === awareness.clientID;
			// Just became the leader: tidy what may have piled up while nobody was.
			if (now && !leading) schedule([]);
			leading = now;
		};

		const onSetting = () => schedule([]);

		const subscribe = () => {
			yNodes.observeDeep(onDoc);
			ySettings.observe(onSetting);
			const offPresence = subscribePresence(onPresence);
			return () => {
				yNodes.unobserveDeep(onDoc);
				ySettings.unobserve(onSetting);
				offPresence();
				window.clearTimeout(timer);
			};
		};

		return {
			subscribe,
			onNodeDragStart: () => {
				dragging = true;
			},
			onNodeDragStop: (_e, _node, nodes) => {
				dragging = false;
				run(new Set(nodes.map((n) => n.id)));
			},
			sizesChanged: (changes) => {
				// A card's first size is not growth: it only asks for a pass (nobody stays put for it).
				// Later changes (an image loading, text growing) make the card an anchor.
				const grown: string[] = [];
				let fresh = false;
				for (const c of changes) {
					if (c.type !== "dimensions" || !c.dimensions) continue;
					const w = Math.round(c.dimensions.width);
					const h = Math.round(c.dimensions.height);
					const was = sizes.get(c.id);
					sizes.set(c.id, { w, h });
					if (!was) fresh = true;
					else if (was.w !== w || was.h !== h) grown.push(c.id);
				}
				if (grown.length > 0 || fresh) schedule(grown);
			},
		};
	}, [store]);
	useEffect(() => tidy.subscribe(), [tidy]);
	return tidy;
}
