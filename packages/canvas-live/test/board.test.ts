import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { boardText, BoardError, edgesOf, exportBoard, f32Text, mergeBoardIntoDoc, nodesOf, parseBoard, seedDoc, spliceText } from "../src/board";
import { placeUnplaced, type LayoutNode } from "../src/layout";

// Real boards from ~/Library/Application Support/EvaOS/canvases, between them every node kind.
const FIXTURES = join(import.meta.dirname, "fixtures");
const boards = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, text: readFileSync(join(FIXTURES, f), "utf8") }));
// Written by an agent's JSON serializer (`\u00b7` escapes), not by EvaOS: same board, other bytes.
const NON_CANONICAL = new Set(["artifacts.json"]);
const canonical = boards.filter((b) => !NON_CANONICAL.has(b.name));

/** Two docs kept in sync both ways, like the host and a browser over the websocket. */
function pair(): { host: Y.Doc; client: Y.Doc; flush: () => void } {
  const host = new Y.Doc();
  const client = new Y.Doc();
  const queue: [Y.Doc, Uint8Array][] = [];
  host.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "remote") queue.push([client, u]);
  });
  client.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "remote") queue.push([host, u]);
  });
  const flush = (): void => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) Y.applyUpdate(next[0], next[1], "remote");
  };
  return { host, client, flush };
}

const text = (doc: Y.Doc, id: string, field: "title" | "body"): Y.Text => nodesOf(doc).get(id)?.get(field) as Y.Text;

describe("boardText", () => {
  it("has fixtures covering every node kind", () => {
    const kinds = new Set(boards.flatMap((b) => parseBoard(b.text).nodes.map((n) => n.type)));
    expect([...kinds].sort()).toEqual(["frame", "image", "link", "note", "palette", "suggestion", "ticket", "topic", "typography"]);
  });

  it("has at least three EvaOS-written fixtures", () => {
    expect(canonical.length).toBeGreaterThanOrEqual(3);
  });

  it.each(canonical)("parse -> boardText is byte-identical for $name", ({ text: t }) => {
    expect(boardText(parseBoard(t))).toBe(t);
  });

  it.each([...NON_CANONICAL])("rewrites %s to the same board in EvaOS's bytes, then is stable", (name) => {
    const t = boards.find((b) => b.name === name)?.text ?? "";
    const out = boardText(parseBoard(t));
    expect(out).not.toBe(t);
    expect(parseBoard(out)).toEqual(parseBoard(t));
    expect(boardText(parseBoard(out))).toBe(out);
  });

  it("writes numbers the way serde_json writes an f32", () => {
    expect([0, -0, 115, 0.31, -560, 1e30, 1.5e-7, 12.5, 0.1].map(f32Text)).toEqual(["0.0", "-0.0", "115.0", "0.31", "-560.0", "1e30", "1.5e-7", "12.5", "0.1"]);
  });

  it("drops unknown fields and refuses newer versions", () => {
    const b = parseBoard('{"version":1,"title":"t","extra":1,"nodes":[{"id":"a","type":"note","z":3,"data":{"title":"x","bogus":2}}]}');
    expect(b.nodes[0]).toEqual({ id: "a", type: "note", data: { title: "x" } });
    expect(() => parseBoard('{"version":2}')).toThrow(BoardError);
    expect(() => parseBoard('{"nodes":[{"id":"a","type":"blob"}]}')).toThrow(BoardError);
  });
});

describe("seed and export", () => {
  it.each(canonical)("seed -> export -> boardText is byte-identical for $name", ({ text: t }) => {
    const doc = new Y.Doc();
    seedDoc(doc, parseBoard(t));
    expect(boardText(exportBoard(doc))).toBe(t);
    // Through a second doc too: what a synced replica exports is the same board.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(boardText(exportBoard(replica))).toBe(t);
  });

  it("lands doc edits in the exported text", () => {
    const source = boards.find((b) => b.name === "artifacts.json");
    if (!source) throw new Error("fixture missing");
    const board = parseBoard(source.text);
    const { host, client, flush } = pair();
    seedDoc(host, board);
    flush();
    const first = board.nodes.find((n) => n.data?.body !== undefined && n.type === "note");
    if (!first) throw new Error("no note with a body");
    // A person types on the client; the agent adds a node, moves one and draws an edge on the host.
    text(client, first.id, "body").insert(0, "Typed live. ");
    flush();
    host.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("type", "suggestion");
      m.set("x", 100);
      m.set("y", 200.5);
      m.set("w", 420);
      m.set("title", new Y.Text("New idea"));
      m.set("body", new Y.Text(""));
      m.set("fields", []);
      nodesOf(host).set("n-new", m);
      nodesOf(host).get(first.id)?.set("x", 12);
      const e = new Y.Map<unknown>();
      e.set("source", first.id);
      e.set("target", "n-new");
      e.set("label", "because");
      edgesOf(host).set("e-new", e);
    }, "agent");
    flush();
    const out = parseBoard(boardText(exportBoard(host)));
    const edited = out.nodes.find((n) => n.id === first.id);
    expect(edited?.data?.body).toBe(`Typed live. ${first.data?.body ?? ""}`);
    expect(edited?.x).toBe(12);
    expect(out.nodes.at(-1)).toEqual({ id: "n-new", type: "suggestion", x: 100, y: 200.5, w: 420, data: { title: "New idea" } });
    expect(out.edges.at(-1)).toEqual({ id: "e-new", source: first.id, target: "n-new", label: "because" });
    // Everything else is untouched.
    expect(out.nodes.filter((n) => n.id !== first.id && n.id !== "n-new")).toEqual(board.nodes.filter((n) => n.id !== first.id));
    expect(boardText(exportBoard(client))).toBe(boardText(exportBoard(host)));
  });
});

describe("mergeBoardIntoDoc", () => {
  const base = parseBoard(boards.find((b) => b.name === "ecs-roles.json")?.text ?? "{}");

  it("brings the doc to an outside write (add, remove, update by id)", () => {
    const doc = new Y.Doc();
    seedDoc(doc, base);
    const next = structuredClone(base);
    const [a, b] = next.nodes;
    if (!a || !b) throw new Error("fixture too small");
    a.data = { ...a.data, title: "Renamed root" };
    a.x = 5;
    next.nodes.splice(1, 1);
    next.edges = next.edges.filter((e) => e.source !== b.id && e.target !== b.id);
    next.nodes.push({ id: "added", type: "note", x: 1, y: 2, data: { body: "from an agent" } });
    next.title = "Retitled";
    mergeBoardIntoDoc(doc, next, "file", base);
    const out = exportBoard(doc);
    expect(out.title).toBe("Retitled");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(next.nodes.map((n) => n.id).sort());
    expect(out.nodes.find((n) => n.id === a.id)).toEqual(a);
    expect(out.edges).toEqual(next.edges);
    expect(boardText(out)).toBe(boardText({ ...next, nodes: [...next.nodes] }));
  });

  it("keeps concurrent typing: a stale writer only applies what it changed", () => {
    const { host, client, flush } = pair();
    seedDoc(host, base);
    flush();
    const [root, other] = base.nodes;
    if (!root || !other) throw new Error("fixture too small");
    const before = root.data?.body ?? "";
    // Typing in the room after the file was last written (the client's keystrokes reach the host).
    text(client, root.id, "body").insert(before.length, " Typed in the room.");
    text(client, other.id, "title").insert(0, "Hot ");
    flush();
    // An outside writer edits the old file: prepends to root's body, retitles... nothing else.
    const outside = structuredClone(base);
    const o0 = outside.nodes[0];
    if (!o0) throw new Error("fixture too small");
    o0.data = { ...o0.data, body: `Agent note. ${before}` };
    mergeBoardIntoDoc(host, outside, "file", base);
    // Typing that happens while the merge lands is kept as well.
    text(client, other.id, "title").insert(text(client, other.id, "title").length, "!");
    flush();
    for (const doc of [host, client]) {
      expect(text(doc, root.id, "body").toJSON()).toBe(`Agent note. ${before} Typed in the room.`);
      expect(text(doc, other.id, "title").toJSON()).toBe(`Hot ${other.data?.title ?? ""}!`);
    }
  });

  it("does not resurrect a node deleted in the room since the base", () => {
    const doc = new Y.Doc();
    seedDoc(doc, base);
    const gone = base.nodes[2]?.id ?? "";
    nodesOf(doc).delete(gone);
    const outside = structuredClone(base);
    outside.title = "Changed elsewhere";
    mergeBoardIntoDoc(doc, outside, "file", base);
    expect(nodesOf(doc).has(gone)).toBe(false);
    expect(exportBoard(doc).title).toBe("Changed elsewhere");
  });

  it("spliceText edits the smallest span", () => {
    const doc = new Y.Doc();
    const t = doc.getText("t");
    t.insert(0, "one two three");
    const deltas: unknown[] = [];
    t.observe((e) => deltas.push(e.delta));
    spliceText(t, "one two three", "one 2 three");
    expect(t.toJSON()).toBe("one 2 three");
    expect(deltas).toEqual([[{ retain: 4 }, { delete: 3 }, { insert: "2" }]]);
  });
});

describe("placeUnplaced", () => {
  it("leaves placed nodes alone and puts the rest to the right", () => {
    const nodes: LayoutNode[] = [
      { id: "a", type: "note", x: 0, y: 0, w: 200, body: "x" },
      { id: "b", type: "note", body: "unplaced" },
      { id: "c", type: "topic" },
    ];
    const at = placeUnplaced(nodes, []);
    expect([...at.keys()].sort()).toEqual(["b", "c"]);
    for (const p of at.values()) expect(p.x).toBeGreaterThanOrEqual(200 + 120);
  });

  it("lays out a board with no positions at all", () => {
    const at = placeUnplaced(
      [
        { id: "root", type: "topic" },
        { id: "k1", type: "note" },
        { id: "k2", type: "note" },
      ],
      [
        { source: "root", target: "k1" },
        { source: "root", target: "k2" },
      ],
    );
    expect(at.size).toBe(3);
    const root = at.get("root");
    const k1 = at.get("k1");
    expect(root && k1 && k1.x !== root.x).toBe(true);
  });
});
