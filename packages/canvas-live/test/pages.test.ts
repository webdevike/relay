import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { boardText, BoardError, duplicatePage, exportBoard, mergeBoardIntoDoc, parseBoard, seedDoc, type Board } from "../src/board";
import { addPage, deletePage, FIRST_PAGE, movePage, pageMaps, pagesOf, renamePage } from "../src/pages";
import { openThread } from "../src/threads";

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "ecs-roles.json"), "utf8");

const TWO_PAGES = `{
  "version": 1,
  "title": "Flows",
  "nodes": [
    {
      "id": "a",
      "type": "note",
      "x": 0.0,
      "y": 0.0,
      "data": {
        "title": "On page one"
      }
    }
  ],
  "edges": [],
  "pages": [
    {
      "id": "page-1",
      "title": "Sign in"
    },
    {
      "id": "checkout",
      "title": "Checkout",
      "nodes": [
        {
          "id": "a",
          "type": "topic",
          "x": 10.0,
          "y": 20.0,
          "data": {
            "title": "Cart"
          }
        },
        {
          "id": "b",
          "type": "note",
          "data": {
            "body": "Pay"
          }
        }
      ],
      "edges": [
        {
          "id": "e1",
          "source": "a",
          "target": "b"
        }
      ],
      "viewport": {
        "x": 5.0,
        "y": 6.0,
        "zoom": 0.5
      },
      "threads": [
        {
          "id": "t1",
          "node": "b",
          "x": 4.0,
          "y": 4.0,
          "messages": [
            {
              "id": "m1",
              "kind": "human",
              "name": "Isaac",
              "color": "#228be6",
              "text": "Shorter?",
              "ts": 1
            }
          ]
        }
      ]
    }
  ]
}
`;

const titles = (doc: Y.Doc): string[] => pagesOf(doc).map((p) => `${p.id}:${p.title}`);
const nodeIds = (doc: Y.Doc, page: string): string[] => [...pageMaps(doc, page).nodes.keys()].sort();

describe("pages in the board file", () => {
  it("parses and writes a board with pages byte for byte, through a doc and its replica too", () => {
    const board = parseBoard(TWO_PAGES);
    expect(board.pages?.map((p) => p.id)).toEqual(["page-1", "checkout"]);
    expect(board.pages?.[0]).toEqual({ id: "page-1", title: "Sign in" });
    expect(board.pages?.[1]?.nodes?.map((n) => n.id)).toEqual(["a", "b"]);
    expect(boardText(board)).toBe(TWO_PAGES);
    const doc = new Y.Doc();
    seedDoc(doc, board);
    expect(titles(doc)).toEqual(["page-1:Sign in", "checkout:Checkout"]);
    expect(nodeIds(doc, FIRST_PAGE)).toEqual(["a"]);
    expect(nodeIds(doc, "checkout")).toEqual(["a", "b"]);
    expect(boardText(exportBoard(doc))).toBe(TWO_PAGES);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(boardText(exportBoard(replica))).toBe(TWO_PAGES);
  });

  it("writes no pages for a single page, so an old board's file is unchanged", () => {
    const doc = new Y.Doc();
    seedDoc(doc, parseBoard(fixture));
    expect(titles(doc)).toEqual(["page-1:Page 1"]);
    expect(addPage(doc, "two", "Two")).toBe(true);
    expect(boardText(exportBoard(doc))).toContain('"pages"');
    expect(deletePage(doc, "two")).toBe(true);
    expect(boardText(exportBoard(doc))).toBe(fixture);
  });

  it("puts page-1 back in front when the list leaves it out but the top level has content", () => {
    const b = parseBoard('{"nodes":[{"id":"a","type":"note"}],"pages":[{"id":"two","title":"Two"}]}');
    expect(b.pages?.map((p) => p.id)).toEqual(["page-1", "two"]);
    const empty = parseBoard('{"pages":[{"id":"two","title":"Two","nodes":[{"id":"x","type":"note"}]}]}');
    expect(empty.pages?.map((p) => p.id)).toEqual(["two"]);
  });

  it("refuses bad and repeated page ids", () => {
    expect(() => parseBoard('{"pages":[{"id":"Bad Id","title":"x"}]}')).toThrow(BoardError);
    expect(() => parseBoard('{"pages":[{"id":"a","title":"x"},{"id":"a","title":"y"}]}')).toThrow(/used twice/);
    expect(() => parseBoard('{"pages":[{"id":"a","title":"x","nodes":[{"id":"n","type":"blob"}]}]}')).toThrow(/pages\[0\]\.nodes\[0\]\.type/);
  });
});

describe("page operations", () => {
  it("adds, renames, moves, duplicates and deletes, keeping each page's content in its own maps", () => {
    const doc = new Y.Doc();
    seedDoc(doc, parseBoard(TWO_PAGES));
    expect(addPage(doc, "checkout", "Again")).toBe(false);
    expect(addPage(doc, "Bad", "x")).toBe(false);
    expect(addPage(doc, "review", "  Review   flow ", FIRST_PAGE)).toBe(true);
    expect(titles(doc)).toEqual(["page-1:Sign in", "review:Review flow", "checkout:Checkout"]);
    expect(renamePage(doc, "review", "")).toBe(true);
    expect(titles(doc)[1]).toBe("review:Page 2");
    expect(movePage(doc, "checkout", 0)).toBe(true);
    expect(titles(doc)).toEqual(["checkout:Checkout", "page-1:Sign in", "review:Page 2"]);
    expect(duplicatePage(doc, "checkout", "checkout-2", "")).toBe(true);
    expect(titles(doc)[1]).toBe("checkout-2:Checkout copy");
    expect(nodeIds(doc, "checkout-2")).toEqual(["a", "b"]);
    // A copy's comments stay on the original.
    expect(pageMaps(doc, "checkout-2").threads.size).toBe(0);
    expect(pageMaps(doc, "checkout").threads.size).toBe(1);
    expect(deletePage(doc, "checkout")).toBe(true);
    expect(pageMaps(doc, "checkout").nodes.size).toBe(0);
    expect(titles(doc)).toEqual(["checkout-2:Checkout copy", "page-1:Sign in", "review:Page 2"]);
  });

  it("deletes page-1 too, and the file says so", () => {
    const doc = new Y.Doc();
    seedDoc(doc, parseBoard(TWO_PAGES));
    expect(deletePage(doc, FIRST_PAGE)).toBe(true);
    expect(deletePage(doc, "checkout")).toBe(false);
    const text = boardText(exportBoard(doc));
    const back = parseBoard(text);
    expect(back.nodes).toEqual([]);
    expect(back.pages?.map((p) => p.id)).toEqual(["checkout"]);
    const again = new Y.Doc();
    seedDoc(again, back);
    expect(boardText(exportBoard(again))).toBe(text);
  });
});

describe("merging pages", () => {
  const base = parseBoard(TWO_PAGES);

  it("leaves the room's pages alone when the writer has no pages", () => {
    const doc = new Y.Doc();
    seedDoc(doc, base);
    const plain: Board = { ...structuredClone(base), title: "Renamed" };
    delete plain.pages;
    mergeBoardIntoDoc(doc, plain, "file", base);
    expect(titles(doc)).toEqual(["page-1:Sign in", "checkout:Checkout"]);
    expect(nodeIds(doc, "checkout")).toEqual(["a", "b"]);
    expect(exportBoard(doc).title).toBe("Renamed");
  });

  it("applies a writer's page edits: content on a page, a new page, a dropped page", () => {
    const doc = new Y.Doc();
    seedDoc(doc, base);
    const next = structuredClone(base);
    const checkout = next.pages?.[1];
    const first = checkout?.nodes?.[0];
    if (!checkout?.nodes || !first) throw new Error("fixture");
    checkout.nodes[0] = { ...first, x: 99 };
    checkout.nodes.push({ id: "c", type: "note" });
    next.pages?.push({ id: "extra", title: "Extra", nodes: [{ id: "z", type: "note" }], edges: [] });
    mergeBoardIntoDoc(doc, next, "file", base);
    expect(titles(doc)).toEqual(["page-1:Sign in", "checkout:Checkout", "extra:Extra"]);
    expect(nodeIds(doc, "checkout")).toEqual(["a", "b", "c"]);
    expect(pageMaps(doc, "checkout").nodes.get("a")?.get("x")).toBe(99);
    expect(nodeIds(doc, "extra")).toEqual(["z"]);
    // page-1's node "a" is its own: a page's edit never touches another page.
    expect(pageMaps(doc, FIRST_PAGE).nodes.get("a")?.get("x")).toBe(0);
    const dropped = structuredClone(next);
    dropped.pages = (dropped.pages ?? []).filter((p) => p.id !== "checkout");
    mergeBoardIntoDoc(doc, dropped, "file", next);
    expect(titles(doc)).toEqual(["page-1:Sign in", "extra:Extra"]);
    expect(nodeIds(doc, "checkout")).toEqual([]);
    expect(boardText(exportBoard(doc))).toBe(boardText(dropped));
  });

  it("does not undo the room's comment on another page when a stale writer saves", () => {
    const doc = new Y.Doc();
    seedDoc(doc, base);
    openThread(pageMaps(doc, "checkout").threads, "t2", { node: "a", x: 1, y: 1 }, { id: "m2", kind: "human", name: "Isaac", color: "#000", text: "New", ts: 5 });
    const stale = structuredClone(base);
    stale.title = "From the desktop";
    mergeBoardIntoDoc(doc, stale, "file", base);
    expect([...pageMaps(doc, "checkout").threads.keys()].sort()).toEqual(["t1", "t2"]);
  });
});
