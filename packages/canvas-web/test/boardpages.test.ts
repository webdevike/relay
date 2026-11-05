import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addPage, deletePage, movePage, pagesOf } from "../../canvas-live/src/pages";
import type { Presence } from "../../canvas-live/src/shared";
import { openThread, snapThreads, threadsOf } from "../../canvas-live/src/threads";
import { dropIndex, fallbackPage, groupByPage, nextPageTitle, onPage, statesOnPage, threadRows } from "../src/boardpages";

const P = (id: string, title = id) => ({ id, title });
const who = (name: string, page?: string): Presence => ({
  user: { name, color: "#000", kind: "human" },
  ...(page === undefined ? {} : { page }),
});

describe("onPage", () => {
  it("puts a presence without a page on page-1", () => {
    expect(onPage(who("a"), "page-1")).toBe(true);
    expect(onPage(who("a", "p-2"), "page-1")).toBe(false);
    const states = new Map([
      [1, who("a")],
      [2, who("b", "p-2")],
      [3, who("c", "page-1")],
    ]);
    expect([...statesOnPage(states, "page-1").keys()]).toEqual([1, 3]);
  });
});

describe("fallbackPage", () => {
  const prev = [P("a"), P("b"), P("c"), P("d")];
  it("stays while the page is still there", () => {
    expect(fallbackPage(prev, [P("b"), P("a")], "a")).toBe("a");
  });
  it("goes to the page after the deleted one, else the one before", () => {
    expect(fallbackPage(prev, [P("a"), P("c"), P("d")], "b")).toBe("c");
    expect(fallbackPage(prev, [P("a"), P("b"), P("c")], "d")).toBe("c");
    // Both neighbours gone too: one further out.
    expect(fallbackPage(prev, [P("d")], "b")).toBe("d");
  });
  it("falls back to the first page for a page it never knew", () => {
    expect(fallbackPage(prev, [P("x"), P("y")], "zzz")).toBe("x");
  });
  it("follows a real delete in the doc", () => {
    const doc = new Y.Doc();
    addPage(doc, "p-2", "Two");
    addPage(doc, "p-3", "Three");
    const before = pagesOf(doc);
    deletePage(doc, "p-2");
    expect(fallbackPage(before, pagesOf(doc), "p-2")).toBe("p-3");
    const again = pagesOf(doc);
    deletePage(doc, "page-1");
    expect(fallbackPage(again, pagesOf(doc), "page-1")).toBe("p-3");
  });
});

describe("groupByPage", () => {
  const pages = [P("page-1", "Page 1"), P("p-2", "Flows"), P("p-3", "Ideas")];
  it("puts the viewer's page first, then the rest in page order, empty pages left out", () => {
    const groups = groupByPage([who("a"), who("b", "p-3"), who("c", "p-2"), who("d", "p-3")], pages, "p-3");
    expect(groups.map((g) => [g.page?.title, g.people.map((p) => p.user.name)])).toEqual([
      ["Ideas", ["b", "d"]],
      ["Page 1", ["a"]],
      ["Flows", ["c"]],
    ]);
  });
  it("keeps people on a page the board no longer has, last and unlabeled", () => {
    const groups = groupByPage([who("a", "gone"), who("b")], pages, "page-1");
    expect(groups.map((g) => [g.page?.id ?? null, g.people.map((p) => p.user.name)])).toEqual([
      ["page-1", ["b"]],
      [null, ["a"]],
    ]);
  });
});

describe("threadRows", () => {
  it("lists every page's threads, open then resolved, newest first, each with its page", () => {
    const doc = new Y.Doc();
    const one = threadsOf(doc);
    const two = doc.getMap<Y.Map<unknown>>("threads:p-2");
    const msg = (id: string, ts: number) => ({ id, kind: "human" as const, name: "Isaac", color: "#000", text: id, ts });
    openThread(one, "t1", { x: 0, y: 0 }, msg("m1", 10));
    openThread(one, "t2", { x: 0, y: 0 }, msg("m2", 30));
    // The same thread id on another page is another thread.
    openThread(two, "t1", { x: 0, y: 0 }, msg("m3", 20));
    openThread(two, "t3", { x: 0, y: 0 }, msg("m4", 40));
    two.get("t3")?.set("resolved", true);
    const rows = threadRows([
      { page: P("page-1", "Page 1"), threads: snapThreads(one) },
      { page: P("p-2", "Flows"), threads: snapThreads(two) },
    ]);
    expect(rows.open.map((r) => [r.page.title, r.thread.id])).toEqual([
      ["Page 1", "t2"],
      ["Flows", "t1"],
      ["Page 1", "t1"],
    ]);
    expect(rows.resolved.map((r) => [r.page.title, r.thread.id])).toEqual([["Flows", "t3"]]);
    expect(new Set([...rows.open, ...rows.resolved].map((r) => r.key)).size).toBe(4);
  });
});

describe("nextPageTitle", () => {
  it("is one past the page count, skipping titles taken", () => {
    expect(nextPageTitle([P("page-1", "Page 1")])).toBe("Page 2");
    expect(nextPageTitle([P("page-1", "Page 1"), P("p", "Page 3")])).toBe("Page 4");
  });
});

describe("dropIndex", () => {
  it("lands a dragged page where it was dropped", () => {
    const order = (from: number, over: number, below: boolean) => {
      const doc = new Y.Doc();
      for (const id of ["b", "c", "d"]) addPage(doc, id, id);
      const id = pagesOf(doc)[from]!.id;
      movePage(doc, id, dropIndex(from, over, below));
      return pagesOf(doc).map((p) => p.id.slice(0, 1));
    };
    // page-1 is "p": [p, b, c, d]
    expect(order(0, 2, true)).toEqual(["b", "c", "p", "d"]);
    expect(order(0, 3, true)).toEqual(["b", "c", "d", "p"]);
    expect(order(3, 0, false)).toEqual(["d", "p", "b", "c"]);
    expect(order(1, 2, false)).toEqual(["p", "b", "c", "d"]);
    expect(order(2, 1, false)).toEqual(["p", "c", "b", "d"]);
  });
});
