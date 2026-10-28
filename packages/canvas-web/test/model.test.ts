import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDiff, freeColor, host, roomAgent, snapEdges, snapNodes, swatchColor, toFlowEdges, toFlowNodes, uniqueName } from "../src/model";

function node(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
	const m = new Y.Map<unknown>();
	doc.getMap<Y.Map<unknown>>("nodes").set(id, m);
	for (const [k, v] of Object.entries(fields)) m.set(k, k === "title" || k === "body" ? new Y.Text(String(v)) : v);
}

function edge(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
	const m = new Y.Map<unknown>();
	doc.getMap<Y.Map<unknown>>("edges").set(id, m);
	for (const [k, v] of Object.entries(fields)) m.set(k, v);
}

describe("toFlowNodes", () => {
	it("puts frames before their children with child positions relative to the frame", () => {
		const doc = new Y.Doc();
		node(doc, "child", { type: "note", x: 140, y: 260, parent: "frame", title: "Inside" });
		node(doc, "frame", { type: "frame", x: 100, y: 200, w: 400, title: "Frame" });
		const flow = toFlowNodes({ nodes: snapNodes(doc.getMap("nodes")), edges: [] });
		expect(flow.map((n) => n.id)).toEqual(["frame", "child"]);
		const [frame, child] = flow;
		expect(frame).toMatchObject({ position: { x: 100, y: 200 }, width: 400, height: 220, zIndex: -1, data: { hasChildren: true } });
		expect(child).toMatchObject({ parentId: "frame", expandParent: true, position: { x: 40, y: 60 }, width: 220 });
	});

	it("grows a frame to hold a child that sticks out", () => {
		const doc = new Y.Doc();
		node(doc, "frame", { type: "frame", x: 0, y: 0, w: 300, h: 200 });
		node(doc, "child", { type: "note", x: 200, y: 150, w: 220, h: 100, parent: "frame" });
		const [frame] = toFlowNodes({ nodes: snapNodes(doc.getMap("nodes")), edges: [] });
		expect(frame).toMatchObject({ width: 436, height: 266 });
	});

	it("ignores a parent that is not a frame, and a parent cycle", () => {
		const doc = new Y.Doc();
		node(doc, "a", { type: "frame", x: 0, y: 0, parent: "b" });
		node(doc, "b", { type: "frame", x: 0, y: 0, parent: "a" });
		node(doc, "c", { type: "note", x: 0, y: 0, parent: "n" });
		node(doc, "n", { type: "note", x: 0, y: 0 });
		const flow = toFlowNodes({ nodes: snapNodes(doc.getMap("nodes")), edges: [] });
		expect(flow.every((n) => n.parentId === undefined)).toBe(true);
	});

	it("places nodes without x/y with the board layout, not on top of each other", () => {
		const doc = new Y.Doc();
		node(doc, "t", { type: "topic", title: "Root" });
		node(doc, "a", { type: "note", title: "A" });
		node(doc, "b", { type: "note", title: "B" });
		const nodes = snapNodes(doc.getMap("nodes"));
		const flow = toFlowNodes({ nodes, edges: [{ source: "t", target: "a" }, { source: "t", target: "b" }] });
		const spots = new Set(flow.map((n) => `${n.position.x},${n.position.y}`));
		expect(spots.size).toBe(3);
	});

	it("keeps the previous node object when nothing about it changed", () => {
		const doc = new Y.Doc();
		node(doc, "a", { type: "note", x: 0, y: 0, title: "A" });
		node(doc, "b", { type: "note", x: 300, y: 0, title: "B" });
		const yNodes = doc.getMap<Y.Map<unknown>>("nodes");
		const first = toFlowNodes({ nodes: snapNodes(yNodes), edges: [] });
		(yNodes.get("b")?.get("title") as Y.Text).insert(1, "!");
		const second = toFlowNodes({ nodes: snapNodes(yNodes), edges: [] }, first);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).not.toBe(first[1]);
		expect(second[1]?.data.spec.title).toBe("B!");
	});

	it("reads every node kind's data", () => {
		const doc = new Y.Doc();
		node(doc, "p", { type: "palette", x: 0, y: 0, title: "Brand", colors: [{ hex: "#ff0000", name: "Red" }, { hex: "00ff00" }, { bad: 1 }] });
		node(doc, "k", { type: "ticket", x: 0, y: 0, title: "Fix", key: "ENG-1", status: "Open", pr: "#12", tone: "danger", fields: ["title", "key"] });
		node(doc, "z", { type: "nonsense", x: 0, y: 0 });
		const [p, k, z] = snapNodes(doc.getMap("nodes"));
		expect(p?.colors).toEqual([{ hex: "#ff0000", name: "Red" }, { hex: "00ff00" }]);
		expect(k).toMatchObject({ key: "ENG-1", status: "Open", pr: "#12", tone: "danger", fields: ["title", "key"] });
		expect(z?.type).toBe("note");
	});
});

describe("edges", () => {
	it("drop edges whose ends are missing and keep handles, label and tone", () => {
		const doc = new Y.Doc();
		edge(doc, "e1", { source: "a", target: "b", sourceHandle: "right", label: "then", tone: "accent" });
		edge(doc, "e2", { source: "a", target: "gone" });
		const flow = toFlowEdges(snapEdges(doc.getMap("edges")), new Set(["a", "b"]));
		expect(flow).toEqual([{ id: "e1", source: "a", target: "b", type: "link", sourceHandle: "right", data: { label: "then", tone: "accent" } }]);
	});
});

describe("applyDiff", () => {
	it("turns a textarea edit into one op that merges with concurrent typing", () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		const ta = a.getText("t");
		ta.insert(0, "Open PRs");
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		const tb = b.getText("t");
		applyDiff(ta, "[Sam] Open PRs");
		tb.insert(tb.length, " list");
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		expect(ta.toString()).toBe("[Sam] Open PRs list");
		expect(tb.toString()).toBe(ta.toString());
	});

	it("handles deletes and replacements in the middle", () => {
		const t = new Y.Doc().getText("t");
		t.insert(0, "hello wide world");
		applyDiff(t, "hello world");
		expect(t.toString()).toBe("hello world");
		applyDiff(t, "hello there world");
		expect(t.toString()).toBe("hello there world");
	});
});

describe("helpers", () => {
	it("names a link by its host", () => {
		expect(host("https://www.dribbble.com/shots/1")).toBe("dribbble.com");
		expect(host("linear.app/team")).toBe("linear.app");
	});

	it("accepts only real hex swatches", () => {
		expect(swatchColor(" #AbCdEf ")).toBe("#AbCdEf");
		expect(swatchColor("12345678")).toBe("#12345678");
		expect(swatchColor("red")).toBeNull();
	});

	it("gives a second tab its own name and a free color", () => {
		expect(uniqueName("Isaac", new Set(["Isaac", "Isaac 2"]))).toBe("Isaac 3");
		expect(uniqueName("Sam", new Set(["Isaac"]))).toBe("Sam");
		expect(freeColor("#0ea5e9", new Set(["#0ea5e9"]))).toBe("#16a34a");
	});

	it("finds the room's agent from the session, /me, presence, or a spike session", () => {
		const nova = { name: "Nova", color: "#f76707", kind: "agent" as const };
		expect(roomAgent({ agent: nova }, null, [])).toBe(nova);
		expect(roomAgent(undefined, { name: "Eva", color: "#8b5cf6" }, [])?.name).toBe("Eva");
		expect(roomAgent(undefined, null, [{ name: "Isaac", color: "#000", kind: "human" }, nova])).toBe(nova);
		expect(roomAgent({ assistant: "Nova", open: true }, null, [])?.name).toBe("Nova");
		expect(roomAgent(undefined, null, [])).toBeNull();
	});
});
