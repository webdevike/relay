import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { boardText, BoardError, exportBoard, mergeBoardIntoDoc, parseBoard, seedDoc } from "../src/board";
import {
  anchorFor,
  CORNER,
  excerpt,
  openThread,
  orderThreads,
  pinAt,
  postInThread,
  setResolved,
  snapThreads,
  threadsOf,
  type ThreadMsg,
} from "../src/threads";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "ecs-roles.json"), "utf8");

const msg = (id: string, kind: ThreadMsg["kind"], text: string, ts: number, extra: Partial<ThreadMsg> = {}): ThreadMsg => ({
  id,
  kind,
  name: kind === "human" ? "Isaac" : "Nova",
  color: kind === "human" ? "#0ea5e9" : "#f76707",
  text,
  ts,
  ...extra,
});

describe("comment threads in the doc", () => {
  it("opens a pin with its first message, takes replies, resolves, and reopens when a human writes again", () => {
    const doc = new Y.Doc();
    const threads = threadsOf(doc);
    expect(openThread(threads, "t-1", { node: "root", x: 40, y: 12 }, msg("m1", "human", "  Tighten this title  ", 1))).toBe(true);
    expect(openThread(threads, "t-1", { x: 0, y: 0 }, msg("m2", "human", "again", 2))).toBe(false);
    expect(openThread(threads, "bad id", { x: 0, y: 0 }, msg("m3", "human", "x", 3))).toBe(false);
    expect(openThread(threads, "t-2", { x: 0, y: 0 }, msg("m4", "human", "   ", 4))).toBe(false);

    expect(postInThread(threads, "t-1", msg("r1", "agent", "Done, it reads Roles now.", 5, { avatar: "/canvas/avatar/nova" }))).toBe(true);
    expect(postInThread(threads, "nope", msg("r2", "agent", "lost", 6))).toBe(false);
    expect(setResolved(threads, "t-1", true)).toBe(true);
    let [t] = snapThreads(threads);
    expect(t).toEqual({
      id: "t-1",
      anchor: { node: "root", x: 40, y: 12 },
      resolved: true,
      messages: [msg("m1", "human", "Tighten this title", 1), msg("r1", "agent", "Done, it reads Roles now.", 5, { avatar: "/canvas/avatar/nova" })],
    });

    // An agent's message leaves it resolved; a human's reopens it.
    postInThread(threads, "t-1", msg("r3", "agent", "Anything else?", 7));
    expect(snapThreads(threads)[0]?.resolved).toBe(true);
    postInThread(threads, "t-1", msg("m5", "human", "One more thing", 8));
    [t] = snapThreads(threads);
    expect(t?.resolved).toBe(false);
    expect(t?.messages.map((m) => m.id)).toEqual(["m1", "r1", "r3", "m5"]);
  });

  it("orders open threads before resolved ones, newest activity first", () => {
    const doc = new Y.Doc();
    const threads = threadsOf(doc);
    openThread(threads, "old", { x: 0, y: 0 }, msg("a", "human", "old", 1));
    openThread(threads, "new", { x: 0, y: 0 }, msg("b", "human", "new", 5));
    openThread(threads, "done", { x: 0, y: 0 }, msg("c", "human", "done", 9));
    setResolved(threads, "done", true);
    postInThread(threads, "old", msg("d", "agent", "bumped", 7));
    const { open, resolved } = orderThreads(snapThreads(threads));
    expect(open.map((t) => t.id)).toEqual(["old", "new"]);
    expect(resolved.map((t) => t.id)).toEqual(["done"]);
  });

  it("anchors a comment on the node it is about and follows the node", () => {
    const box = { x: 100, y: 200, w: 300, h: 120 };
    // Inside the node: that spot, as an offset.
    expect(anchorFor({ x: 160, y: 230 }, { id: "n", box })).toEqual({ node: "n", x: 60, y: 30 });
    // Outside it (the keyboard, the Comment button): the node's top-right corner.
    expect(anchorFor({ x: 900, y: 900 }, { id: "n", box })).toEqual({ node: "n", x: 300 - CORNER.right, y: CORNER.top });
    expect(anchorFor(null, { id: "n", box })).toEqual({ node: "n", x: 300 - CORNER.right, y: CORNER.top });
    // No node: the board point.
    expect(anchorFor({ x: 12.4, y: -8.6 }, null)).toEqual({ x: 12, y: -9 });

    const anchor = { node: "n", x: 60, y: 30 };
    expect(pinAt(anchor, box)).toEqual({ x: 160, y: 230 });
    // The node moved: the pin moves with it.
    expect(pinAt(anchor, { ...box, x: 500, y: 40 })).toEqual({ x: 560, y: 70 });
    // The node shrank: the pin stays on it.
    expect(pinAt({ node: "n", x: 280, y: 100 }, { ...box, w: 200, h: 50 })).toEqual({ x: 300, y: 250 });
    // The node is gone: no pin on the board.
    expect(pinAt(anchor, null)).toBeNull();
    expect(pinAt({ x: 5, y: 6 }, null)).toEqual({ x: 5, y: 6 });
  });

  it("clips an excerpt to one line", () => {
    expect(excerpt("a\n  b   c", 90)).toBe("a b c");
    expect(excerpt("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("threads in the board file", () => {
  it("leaves a board without threads byte for byte as it was", () => {
    const board = parseBoard(FIXTURE);
    expect(board.threads).toBeUndefined();
    const doc = new Y.Doc();
    seedDoc(doc, board);
    expect(exportBoard(doc).threads).toBeUndefined();
    expect(boardText(exportBoard(doc))).toBe(FIXTURE);
  });

  it("writes pins and their threads after the board, and reads them back into a doc", () => {
    const doc = new Y.Doc();
    seedDoc(doc, parseBoard(FIXTURE));
    const threads = threadsOf(doc);
    openThread(threads, "t-b", { x: -40.5, y: 300 }, msg("m2", "human", "What goes here?", 20));
    openThread(threads, "t-a", { node: "root", x: 200, y: 18 }, msg("m1", "human", "Rename to Roles", 10));
    postInThread(threads, "t-a", msg("r1", "agent", "Renamed it.", 11, { avatar: "/canvas/avatar/nova" }));
    setResolved(threads, "t-a", true);

    const text = boardText(exportBoard(doc));
    // The old part of the file is untouched; threads come last, oldest first.
    expect(text.startsWith(FIXTURE.slice(0, FIXTURE.lastIndexOf("\n}")))).toBe(true);
    const tail = text.slice(text.indexOf('  "threads": ['));
    expect(tail).toBe(`  "threads": [
    {
      "id": "t-a",
      "node": "root",
      "x": 200.0,
      "y": 18.0,
      "resolved": true,
      "messages": [
        {
          "id": "m1",
          "kind": "human",
          "name": "Isaac",
          "color": "#0ea5e9",
          "text": "Rename to Roles",
          "ts": 10
        },
        {
          "id": "r1",
          "kind": "agent",
          "name": "Nova",
          "color": "#f76707",
          "avatar": "/canvas/avatar/nova",
          "text": "Renamed it.",
          "ts": 11
        }
      ]
    },
    {
      "id": "t-b",
      "x": -40.5,
      "y": 300.0,
      "messages": [
        {
          "id": "m2",
          "kind": "human",
          "name": "Isaac",
          "color": "#0ea5e9",
          "text": "What goes here?",
          "ts": 20
        }
      ]
    }
  ]
}
`);

    const reread = parseBoard(text);
    const again = new Y.Doc();
    seedDoc(again, reread);
    expect(boardText(exportBoard(again))).toBe(text);
    expect(snapThreads(threadsOf(again)).find((t) => t.id === "t-a")?.messages[1]?.avatar).toBe("/canvas/avatar/nova");
  });

  it("refuses malformed threads", () => {
    const withThreads = (threads: unknown): string => JSON.stringify({ version: 1, title: "b", nodes: [], edges: [], threads });
    expect(() => parseBoard(withThreads({}))).toThrow(BoardError);
    expect(() => parseBoard(withThreads([{ id: "t", y: 1, messages: [] }]))).toThrow(BoardError);
    expect(() => parseBoard(withThreads([{ id: "t", x: 1, y: 1, messages: [{ id: "m", kind: "robot", name: "a", color: "#fff", text: "x", ts: 1 }] }]))).toThrow(BoardError);
    expect(() => parseBoard(withThreads([{ id: "has space", x: 1, y: 1 }]))).toThrow(BoardError);
    expect(parseBoard(withThreads([{ id: "t", x: 1, y: 2 }])).threads).toEqual([{ id: "t", x: 1, y: 2, messages: [] }]);
  });

  it("merges an outside write's threads by id, never dropping the room's pins when the writer has none", () => {
    const doc = new Y.Doc();
    const base = parseBoard(FIXTURE);
    seedDoc(doc, base);
    const threads = threadsOf(doc);
    openThread(threads, "t-a", { node: "root", x: 10, y: 10 }, msg("m1", "human", "First", 1));
    const written = exportBoard(doc);

    // EvaOS (or an older Relay) rewrites the board without `threads`: the pin stays.
    const { threads: _dropped, ...withoutThreads } = written;
    mergeBoardIntoDoc(doc, { ...withoutThreads, title: "Renamed elsewhere" }, "file", written);
    expect(snapThreads(threads).map((t) => t.id)).toEqual(["t-a"]);

    // A writer that knows threads: a reply, a resolve and a new pin land; messages are only added.
    postInThread(threads, "t-a", msg("m2", "human", "Typed in the room meanwhile", 3));
    const outside = parseBoard(boardText(written));
    const t = outside.threads?.[0];
    if (t === undefined) throw new Error("no thread");
    t.resolved = true;
    t.messages.push(msg("r1", "agent", "From a writer", 2));
    outside.threads?.push({ id: "t-new", x: 5, y: 5, messages: [msg("m9", "human", "New", 9)] });
    mergeBoardIntoDoc(doc, outside, "file", written);
    const [a, b] = orderThreads(snapThreads(threads)).resolved.concat(orderThreads(snapThreads(threads)).open);
    expect(a?.id).toBe("t-a");
    expect(a?.resolved).toBe(true);
    expect(a?.messages.map((m) => m.id)).toEqual(["m1", "m2", "r1"]);
    expect(b?.id).toBe("t-new");

    // A writer that deleted a pin (relative to its base) deletes it.
    const now = exportBoard(doc);
    mergeBoardIntoDoc(doc, { ...now, threads: (now.threads ?? []).filter((x) => x.id !== "t-new") }, "file", now);
    expect(snapThreads(threads).map((x) => x.id)).toEqual(["t-a"]);
  });
});
