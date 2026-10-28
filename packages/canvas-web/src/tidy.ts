// Tidy: cards never overlap. Pure: `separate` takes the drawn boxes and says where the cards that
// must give way go; useTidy.ts decides when it runs and writes the moves into the doc.
import type { Presence } from "../../canvas-live/src/shared";

/** Space kept around a card that was just dropped, added, grown or pushed, in flow units. */
export const TIDY_GAP = 24;

/** A card as drawn: absolute top-left and size, and the frame it sits in ("" when loose). */
export interface Box {
	id: string;
	group: string;
	x: number;
	y: number;
	w: number;
	h: number;
	/** Placed by the board layout (no position in the file): others give way, it never moves. */
	fixed?: boolean;
}

interface Body extends Box {
	/** Pushes away from a card that stays put: -1 fixed, 0 anchor, Infinity until it pushes or is pushed. */
	level: number;
	/** Dropped, added, grown or pushed: keeps the gap from every card, not just off them. */
	touched: boolean;
}

/** Whether `a` and `b` come closer than `pad` (0: whether they overlap). */
function within(a: Box, b: Box, pad: number): boolean {
	return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Moves `mover` out of `pusher` along the shortest way that keeps the gap from cards already settled. */
function push(mover: Body, pusher: Body, settled: readonly Body[], gap: number): void {
	const options: [number, number][] = [
		[Math.ceil(pusher.x + pusher.w + gap - mover.x), 0],
		[-Math.ceil(mover.x + mover.w + gap - pusher.x), 0],
		[0, Math.ceil(pusher.y + pusher.h + gap - mover.y)],
		[0, -Math.ceil(mover.y + mover.h + gap - pusher.y)],
	];
	options.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
	const clear = options.find(([dx, dy]) => !settled.some((s) => s !== mover && within({ ...mover, x: mover.x + dx, y: mover.y + dy }, s, gap - 1)));
	const [dx, dy] = clear ?? (options[0] as [number, number]);
	mover.x += dx;
	mover.y += dy;
}

/**
 * New top-left corners for the cards that move so that no two cards in the same group overlap,
 * each pushed the shortest way out of the card it hits and left `gap` from it. Cards in `anchors`
 * (just dropped, added or grown) and the cards they push keep `gap` from everything; cards nobody
 * touched only have to stop overlapping, so a tight layout stays as it is. Fixed cards never move,
 * anchors give way only to them and to each other; otherwise the card later in reading order (top
 * to bottom, then left to right) moves, and a pushed card pushes what it lands on.
 * Unmoved cards are not in the result.
 */
export function separate(boxes: readonly Box[], anchors: ReadonlySet<string> = new Set(), gap = TIDY_GAP): Map<string, { x: number; y: number }> {
	const groups = new Map<string, Body[]>();
	for (const b of boxes) {
		const body: Body = { ...b, level: b.fixed ? -1 : anchors.has(b.id) ? 0 : Infinity, touched: anchors.has(b.id) };
		const list = groups.get(b.group);
		if (list) list.push(body);
		else groups.set(b.group, [body]);
	}
	const was = new Map(boxes.map((b) => [b.id, b]));
	const moved = new Map<string, { x: number; y: number }>();
	for (const list of groups.values()) {
		list.sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		// Each pass settles every clashing pair once; a push can land on another card, so repeat
		// until a pass changes nothing (bounded, in case two cards keep trading places).
		for (let pass = 0; pass < 4 * list.length; pass++) {
			let changed = false;
			for (let i = 0; i < list.length; i++) {
				for (let j = i + 1; j < list.length; j++) {
					const a = list[i] as Body;
					const b = list[j] as Body;
					if ((a.fixed && b.fixed) || !within(a, b, a.touched || b.touched ? gap - 1 : 0)) continue;
					const [pusher, mover] = a.level > b.level ? [b, a] : [a, b];
					if (pusher.level === Infinity) pusher.level = 0;
					mover.level = Math.min(mover.level, pusher.level + 1);
					mover.touched = true;
					push(
						mover,
						pusher,
						list.filter((c) => c.level < mover.level),
						gap,
					);
					changed = true;
				}
			}
			if (!changed) break;
		}
		for (const b of list) {
			const old = was.get(b.id);
			if (old && (old.x !== b.x || old.y !== b.y)) moved.set(b.id, { x: b.x, y: b.y });
		}
	}
	return moved;
}

/**
 * The client that tidies changes no client owns (the agent's edits, images growing, older
 * clients' drops): the lowest awareness id among the humans whose client tidies. Null when none.
 */
export function tidyLeader(states: ReadonlyMap<number, Presence>): number | null {
	let leader: number | null = null;
	for (const [id, s] of states) if (s.user?.kind === "human" && s.tidy === true && (leader === null || id < leader)) leader = id;
	return leader;
}
