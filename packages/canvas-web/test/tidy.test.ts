import { describe, expect, it } from "vitest";
import type { Presence } from "../../canvas-live/src/shared";
import { type Rect, crossesAny, inflate, intersects, routeEdge } from "../src/route";
import { type Box, TIDY_GAP, separate, tidyLeader } from "../src/tidy";

const box = (id: string, x: number, y: number, w = 200, h = 100, group = ""): Box => ({ id, group, x, y, w, h });

function settle(boxes: Box[], anchors: string[] = []): Box[] {
	const moves = separate(boxes, new Set(anchors));
	return boxes.map((b) => ({ ...b, ...moves.get(b.id) }));
}

function overlapping(boxes: Box[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxes[i]?.group === boxes[j]?.group && intersects(boxes[i] as Box, boxes[j] as Box)) out.push(`${boxes[i]?.id}/${boxes[j]?.id}`);
	return out;
}

describe("separate", () => {
	it("leaves a board without overlaps alone", () => {
		expect(separate([box("a", 0, 0), box("b", 210, 0)]).size).toBe(0);
	});

	it("pushes the card a dropped card lands on the shortest way, a gap away", () => {
		const moves = separate([box("a", 0, 0), box("b", 150, 10)], new Set(["b"]));
		// b was dropped: a gives way, left (50 + gap) is shorter than down or up.
		expect(moves.get("b")).toBeUndefined();
		expect(moves.get("a")).toEqual({ x: 150 - 200 - TIDY_GAP, y: 0 });
	});

	it("cascades a push into the next card", () => {
		const after = settle([box("drop", 0, 0), box("b", 0, 50), box("c", 0, 150)], ["drop"]);
		expect(overlapping(after)).toEqual([]);
		expect(after.find((b) => b.id === "drop")).toMatchObject({ x: 0, y: 0 });
	});

	it("clears a pile of overlapping cards", () => {
		const pile = Array.from({ length: 12 }, (_, i) => box(`n${i}`, (i % 4) * 60, Math.floor(i / 4) * 40));
		expect(overlapping(settle(pile))).toEqual([]);
	});

	it("only separates cards in the same frame", () => {
		expect(separate([box("frame", 0, 0, 600, 400), box("child", 20, 40, 200, 100, "frame")]).size).toBe(0);
	});

	it("leaves a tight layout nobody touched as it is", () => {
		expect(separate([box("a", 0, 0), box("b", 216, 0)]).size).toBe(0);
	});

	it("keeps the gap around a dropped card", () => {
		const moves = separate([box("a", 0, 0), box("b", 210, 0)], new Set(["a"]));
		expect(moves.get("b")).toEqual({ x: 200 + TIDY_GAP, y: 0 });
	});

	it("never moves a card the board layout placed", () => {
		const moves = separate([{ ...box("laid-out", 0, 0), fixed: true }, box("drop", 100, 20)], new Set(["drop"]));
		expect(moves.get("laid-out")).toBeUndefined();
		// Down (80 + gap) is shorter than right (100 + gap).
		expect(moves.get("drop")).toEqual({ x: 100, y: 100 + TIDY_GAP });
	});
});

describe("tidyLeader", () => {
	it("is the lowest human client that tidies", () => {
		const human = (tidy?: boolean): Presence => ({ user: { name: "I", color: "#000", kind: "human" }, ...(tidy === undefined ? {} : { tidy }) });
		const states = new Map<number, Presence>([
			[3, human(true)],
			[1, human()],
			[2, { user: { name: "Nova", color: "#000", kind: "agent" }, tidy: true }],
			[5, human(true)],
		]);
		expect(tidyLeader(states)).toBe(3);
		expect(tidyLeader(new Map([[1, human()]]))).toBeNull();
	});
});

describe("routeEdge", () => {
	const a: Rect = { x: 0, y: 0, w: 200, h: 100 };
	const b: Rect = { x: 600, y: 0, w: 200, h: 100 };

	it("runs straight between facing sides when nothing is in the way", () => {
		expect(routeEdge(a, "right", b, "left", [a, b])).toEqual([
			[200, 50],
			[800 - 200, 50],
		]);
	});

	it("goes around a card in the way and keeps the margin", () => {
		const wall: Rect = { x: 300, y: -100, w: 200, h: 300 };
		const pts = routeEdge(a, "right", b, "left", [a, b, wall]);
		expect(pts[0]).toEqual([200, 50]);
		expect(pts[pts.length - 1]).toEqual([600, 50]);
		expect(crossesAny(pts, [inflate(wall, 9)])).toBe(false);
		expect(pts.length).toBeGreaterThan(2);
	});

	it("leaves and enters through the named handles", () => {
		const below: Rect = { x: 0, y: 400, w: 200, h: 100 };
		const pts = routeEdge(a, "right", below, "left", [a, below]);
		expect(pts[0]).toEqual([200, 50]);
		expect(pts[1]?.[1]).toBe(50);
		expect(pts[pts.length - 1]).toEqual([0, 450]);
		expect(crossesAny(pts, [a, below])).toBe(false);
	});

	it("leaves between cards packed tighter than the margin and still goes around the neighbor", () => {
		const wall: Rect = { x: 216, y: -50, w: 100, h: 200 };
		const right: Rect = { x: 400, y: 0, w: 200, h: 100 };
		const pts = routeEdge(a, "right", right, "left", [a, wall, right]);
		expect(crossesAny(pts, [a, wall, right])).toBe(false);
	});
});
