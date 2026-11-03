import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { LOCAL_ORIGIN, createUndo, deleteNodes, framesWithOutsideChildren, groupNodes, toggleId } from "../src/model";

function board() {
	const doc = new Y.Doc();
	const nodes = doc.getMap<Y.Map<unknown>>("nodes");
	const edges = doc.getMap<Y.Map<unknown>>("edges");
	const add = (id: string, fields: Record<string, unknown>) => {
		const m = new Y.Map<unknown>();
		nodes.set(id, m);
		for (const [k, v] of Object.entries(fields)) m.set(k, k === "title" ? new Y.Text(String(v)) : v);
	};
	const link = (id: string, source: string, target: string) => {
		const m = new Y.Map<unknown>();
		edges.set(id, m);
		m.set("source", source);
		m.set("target", target);
	};
	return { doc, nodes, edges, add, link };
}

describe("toggleId", () => {
	it("adds a card to the selection and removes one that is already in it (Shift-click)", () => {
		expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
		expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
		expect(toggleId([], "a")).toEqual(["a"]);
	});
});

describe("deleteNodes", () => {
	it("removes the nodes and every edge on them", () => {
		const b = board();
		b.add("a", { type: "note", x: 0, y: 0 });
		b.add("b", { type: "note", x: 10, y: 0 });
		b.add("c", { type: "note", x: 20, y: 0 });
		b.link("ab", "a", "b");
		b.link("bc", "b", "c");
		b.link("ca", "c", "a");
		expect(deleteNodes(b.nodes, b.edges, ["a", "b", "gone"]).sort()).toEqual(["a", "b"]);
		expect([...b.nodes.keys()]).toEqual(["c"]);
		expect([...b.edges.keys()]).toEqual([]);
	});

	it("keeps a deleted frame's cards by default, handing them to the frame above", () => {
		const b = board();
		b.add("outer", { type: "frame", x: 0, y: 0 });
		b.add("inner", { type: "frame", x: 10, y: 10, parent: "outer" });
		b.add("card", { type: "note", x: 20, y: 20, parent: "inner" });
		b.add("loose", { type: "note", x: 30, y: 30, parent: "outer" });
		expect(framesWithOutsideChildren(b.nodes, ["inner"])).toEqual(["inner"]);
		deleteNodes(b.nodes, b.edges, ["inner"]);
		expect(b.nodes.has("inner")).toBe(false);
		expect(b.nodes.get("card")?.get("parent")).toBe("outer");
		expect(b.nodes.get("card")?.get("x")).toBe(20);
		deleteNodes(b.nodes, b.edges, ["outer"]);
		expect(b.nodes.get("card")?.has("parent")).toBe(false);
		expect(b.nodes.get("loose")?.has("parent")).toBe(false);
	});

	it("deletes a frame's cards with it when asked, and does not ask when they go too", () => {
		const b = board();
		b.add("f", { type: "frame", x: 0, y: 0 });
		b.add("a", { type: "note", x: 0, y: 0, parent: "f" });
		b.add("keep", { type: "note", x: 0, y: 0 });
		expect(framesWithOutsideChildren(b.nodes, ["f", "a"])).toEqual([]);
		deleteNodes(b.nodes, b.edges, ["f"], false);
		expect([...b.nodes.keys()]).toEqual(["keep"]);
	});
});

describe("undo", () => {
	it("undoes and redoes a delete, edges and text included, as one step", () => {
		const b = board();
		b.add("a", { type: "note", x: 5, y: 6, title: "Hello" });
		b.add("b", { type: "note", x: 0, y: 0 });
		b.link("ab", "a", "b");
		const um = createUndo(b.nodes, b.edges);
		b.doc.transact(() => {
			deleteNodes(b.nodes, b.edges, ["a"]);
		}, LOCAL_ORIGIN);
		um.stopCapturing();
		expect(b.nodes.has("a")).toBe(false);
		expect(b.edges.size).toBe(0);
		um.undo();
		expect(b.nodes.get("a")?.get("x")).toBe(5);
		expect(String(b.nodes.get("a")?.get("title"))).toBe("Hello");
		expect(b.edges.get("ab")?.get("target")).toBe("b");
		um.redo();
		expect(b.nodes.has("a")).toBe(false);
	});

	it("undoes a whole drag (many moves) in one step, and a group", () => {
		const b = board();
		b.add("a", { type: "note", x: 0, y: 0, w: 220, h: 100 });
		b.add("b", { type: "note", x: 300, y: 0, w: 220, h: 100 });
		const um = createUndo(b.nodes, b.edges);
		um.stopCapturing();
		for (let x = 1; x <= 20; x++) {
			b.doc.transact(() => {
				b.nodes.get("a")?.set("x", x);
				b.nodes.get("b")?.set("x", 300 + x);
			}, LOCAL_ORIGIN);
		}
		um.stopCapturing();
		b.doc.transact(() => {
			groupNodes(b.nodes, [{ id: "a", type: "note", x: 20, y: 0, w: 220, h: 100 }, { id: "b", type: "note", x: 320, y: 0, w: 220, h: 100 }], ["a", "b"], "grp");
		}, LOCAL_ORIGIN);
		um.stopCapturing();
		um.undo();
		expect(b.nodes.has("grp")).toBe(false);
		expect(b.nodes.get("a")?.has("parent")).toBe(false);
		expect(b.nodes.get("a")?.get("x")).toBe(20);
		um.undo();
		expect(b.nodes.get("a")?.get("x")).toBe(0);
		expect(b.nodes.get("b")?.get("x")).toBe(300);
	});

	it("never undoes someone else's edit, and a delete another client made stays deleted", () => {
		const mine = board();
		mine.add("a", { type: "note", x: 0, y: 0 });
		mine.add("b", { type: "note", x: 0, y: 0 });
		const um = createUndo(mine.nodes, mine.edges);
		// The agent (no tracked origin) moves b; I delete a.
		mine.doc.transact(() => mine.nodes.get("b")?.set("x", 99), "agent");
		mine.doc.transact(() => {
			deleteNodes(mine.nodes, mine.edges, ["a"]);
		}, LOCAL_ORIGIN);
		um.undo();
		expect(mine.nodes.has("a")).toBe(true);
		expect(mine.nodes.get("b")?.get("x")).toBe(99);
		um.undo();
		expect(mine.nodes.get("b")?.get("x")).toBe(99);
	});

	it("syncs a delete to another client", () => {
		const a = board();
		const peer = new Y.Doc();
		a.add("n", { type: "note", x: 0, y: 0 });
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(a.doc));
		a.doc.on("update", (u: Uint8Array) => Y.applyUpdate(peer, u));
		a.doc.transact(() => {
			deleteNodes(a.nodes, a.edges, ["n"]);
		}, LOCAL_ORIGIN);
		expect(peer.getMap("nodes").has("n")).toBe(false);
	});
});
