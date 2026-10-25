import { describe, expect, it } from "vitest";
import {
  addWidget,
  DEFAULT_WIDGETS,
  flowRows,
  layoutSlots,
  moveToPage,
  moveWidget,
  nextWidgetId,
  normalizeWidgets,
  paginateWidgets,
  removeWidget,
  resizeWidget,
  shiftWidget,
  slotAt,
  widgetBox,
  withWidgetOnce,
  type HomeWidget,
} from "./layout";

const s = (id: string): HomeWidget => ({ id, kind: "inbox", size: "small" });
const m = (id: string): HomeWidget => ({ id, kind: "usage", size: "medium" });
const l = (id: string): HomeWidget => ({ id, kind: "apps", size: "large" });
const ids = (widgets: readonly HomeWidget[]): string[] => widgets.map((w) => w.id);

describe("normalizeWidgets", () => {
  it("gives the default layout when nothing was stored", () => {
    expect(normalizeWidgets(undefined)).toEqual(DEFAULT_WIDGETS);
    expect(normalizeWidgets(null)).toEqual(DEFAULT_WIDGETS);
    expect(ids(DEFAULT_WIDGETS)).toEqual(["catchup-1", "usage-1", "assistants-1", "inbox-1", "apps-1"]);
    expect(DEFAULT_WIDGETS.map((w) => w.size)).toEqual(["medium", "medium", "small", "small", "large"]);
  });

  it("keeps an emptied layout empty", () => {
    expect(normalizeWidgets([])).toEqual([]);
  });

  it("drops unknown kinds, junk and duplicate ids, and fits unsupported sizes", () => {
    expect(
      normalizeWidgets([
        { id: "a", kind: "inbox", size: "medium" },
        { id: "a", kind: "usage", size: "small" },
        { id: "b", kind: "weather", size: "small" },
        { id: "c", kind: "boards", size: "medium" },
        { id: "d", kind: "usage", size: "huge" },
        { id: "e", kind: "apps", size: "small" },
        { id: "f", kind: "apps", size: "large" },
        "nope",
        null,
        { kind: "usage", size: "small" },
      ]),
    ).toEqual([
      { id: "a", kind: "inbox", size: "medium" },
      { id: "c", kind: "boards", size: "small" },
      { id: "d", kind: "usage", size: "small" },
      { id: "e", kind: "apps", size: "medium" },
      { id: "f", kind: "apps", size: "large" },
    ]);
  });
});

describe("withWidgetOnce", () => {
  it("adds the kind at the end or the start of a layout without one", () => {
    expect(withWidgetOnce([s("a")], "apps", "large", "end")).toEqual([s("a"), { id: "apps-1", kind: "apps", size: "large" }]);
    expect(withWidgetOnce([], "apps", "large", "end")).toEqual([{ id: "apps-1", kind: "apps", size: "large" }]);
    expect(withWidgetOnce([s("a"), l("b")], "catchup", "medium", "start")).toEqual([
      { id: "catchup-1", kind: "catchup", size: "medium" },
      s("a"),
      l("b"),
    ]);
  });

  it("leaves a layout that has one as it is", () => {
    const widgets = [{ id: "apps-2", kind: "apps", size: "medium" } as const, s("a")];
    expect(withWidgetOnce(widgets, "apps", "large", "end")).toEqual(widgets);
    const small = [s("a"), { id: "catchup-3", kind: "catchup", size: "small" } as const];
    expect(withWidgetOnce(small, "catchup", "medium", "start")).toEqual(small);
  });
});

describe("add, remove, resize", () => {
  it("appends with the lowest free id of the kind", () => {
    const start = [
      { id: "inbox-1", kind: "inbox", size: "small" } as const,
      { id: "inbox-3", kind: "inbox", size: "small" } as const,
    ];
    expect(nextWidgetId(start, "inbox")).toBe("inbox-2");
    expect(nextWidgetId(start, "usage")).toBe("usage-1");
    const next = addWidget(start, "inbox", "medium");
    expect(next.at(-1)).toEqual({ id: "inbox-2", kind: "inbox", size: "medium" });
    expect(start).toHaveLength(2);
  });

  it("adds a kind at its smallest size when the size is not offered", () => {
    expect(addWidget([], "boards", "medium")).toEqual([
      { id: "boards-1", kind: "boards", size: "small" },
    ]);
  });

  it("removes by id", () => {
    expect(ids(removeWidget([s("a"), s("b"), s("c")], "b"))).toEqual(["a", "c"]);
  });

  it("resizes only to a size the kind offers", () => {
    const widgets: HomeWidget[] = [s("a"), { id: "b", kind: "boards", size: "small" }];
    expect(resizeWidget(widgets, "a", "medium")[0]?.size).toBe("medium");
    expect(resizeWidget(widgets, "b", "medium")[1]?.size).toBe("small");
    expect(resizeWidget(widgets, "a", "large")[0]?.size).toBe("small");
    expect(resizeWidget([l("c")], "c", "medium")[0]?.size).toBe("medium");
    expect(resizeWidget([l("c")], "c", "small")[0]?.size).toBe("large");
  });
});

describe("reorder", () => {
  const list = [s("a"), s("b"), s("c"), s("d")];

  it("moves to an index, shifting the others", () => {
    expect(ids(moveWidget(list, "a", 2))).toEqual(["b", "c", "a", "d"]);
    expect(ids(moveWidget(list, "d", 0))).toEqual(["d", "a", "b", "c"]);
    expect(ids(moveWidget(list, "b", 99))).toEqual(["a", "c", "d", "b"]);
    expect(ids(moveWidget(list, "zz", 0))).toEqual(["a", "b", "c", "d"]);
  });

  it("shifts one step, stopping at the ends", () => {
    expect(ids(shiftWidget(list, "c", -1))).toEqual(["a", "c", "b", "d"]);
    expect(ids(shiftWidget(list, "c", 1))).toEqual(["a", "b", "d", "c"]);
    expect(ids(shiftWidget(list, "a", -1))).toEqual(["a", "b", "c", "d"]);
    expect(ids(shiftWidget(list, "d", 1))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("flow and slots", () => {
  it("pairs smalls and gives mediums a row of their own", () => {
    expect(flowRows([m("m1"), s("a"), s("b"), s("c"), m("m2"), s("d")]).map(ids)).toEqual([
      ["m1"],
      ["a", "b"],
      ["c"],
      ["m2"],
      ["d"],
    ]);
    expect(flowRows([])).toEqual([]);
  });

  it("gives large widgets a row of their own", () => {
    expect(flowRows([s("a"), l("l1"), s("b"), s("c"), l("l2"), m("m")]).map(ids)).toEqual([
      ["a"],
      ["l1"],
      ["b", "c"],
      ["l2"],
      ["m"],
    ]);
  });

  it("sizes each size like iOS", () => {
    const metrics = { width: 210, gap: 10 };
    expect(widgetBox("small", metrics)).toEqual({ width: 100, height: 100 });
    expect(widgetBox("medium", metrics)).toEqual({ width: 210, height: 100 });
    expect(widgetBox("large", metrics)).toEqual({ width: 210, height: 210 });
  });

  it("stacks rows of different heights", () => {
    const { slots, height } = layoutSlots([s("a"), l("l"), m("m"), s("b"), s("c"), l("k")], {
      width: 210,
      gap: 10,
    });
    expect(slots).toEqual([
      { id: "a", x: 0, y: 0, width: 100, height: 100 },
      { id: "l", x: 0, y: 110, width: 210, height: 210 },
      { id: "m", x: 0, y: 330, width: 210, height: 100 },
      { id: "b", x: 0, y: 440, width: 100, height: 100 },
      { id: "c", x: 110, y: 440, width: 100, height: 100 },
      { id: "k", x: 0, y: 550, width: 210, height: 210 },
    ]);
    expect(height).toBe(760);
    expect(layoutSlots([l("l")], { width: 210, gap: 10 }).height).toBe(210);
    // A point low in a large widget is still that widget.
    expect(slotAt(slots, 50, 300, "x")).toBe("l");
  });

  it("places widgets and sizes the grid", () => {
    const { slots, height } = layoutSlots([m("m"), s("a"), s("b"), s("c")], {
      width: 210,
      gap: 10,
    });
    // Side (210 - 10) / 2 = 100; rows 10 apart.
    expect(slots).toEqual([
      { id: "m", x: 0, y: 0, width: 210, height: 100 },
      { id: "a", x: 0, y: 110, width: 100, height: 100 },
      { id: "b", x: 110, y: 110, width: 100, height: 100 },
      { id: "c", x: 0, y: 220, width: 100, height: 100 },
    ]);
    expect(height).toBe(320);
    expect(layoutSlots([], { width: 210, gap: 10 }).height).toBe(0);
  });

  it("finds the slot under a point, skipping the dragged one and gaps", () => {
    const { slots } = layoutSlots([s("a"), s("b")], { width: 210, gap: 10 });
    expect(slotAt(slots, 150, 50, "a")).toBe("b");
    expect(slotAt(slots, 50, 50, "a")).toBeNull();
    expect(slotAt(slots, 105, 50, "x")).toBeNull();
    // The gap between rows is not a widget.
    expect(slotAt(slots, 50, 105, "x")).toBeNull();
  });
});

describe("pages", () => {
  const metrics = { width: 210, gap: 10 };
  const pageIds = (pages: HomeWidget[][]): string[][] => pages.map(ids);

  it("fills a page with as many rows as fit, breaking between rows", () => {
    // Rows 100 (m), 100 (a b), 210 (l), 100 (c): 100 + 10 + 100 = 210 fits 320, + 10 + 210 does not.
    const widgets = [m("m"), s("a"), s("b"), l("l"), s("c")];
    expect(pageIds(paginateWidgets(widgets, metrics, 320))).toEqual([["m", "a", "b"], ["l", "c"]]);
    // Exactly the page height still fits.
    expect(pageIds(paginateWidgets(widgets, metrics, 210))).toEqual([["m", "a", "b"], ["l"], ["c"]]);
  });

  it("keeps everything on one page when it fits, and no pages when empty", () => {
    expect(pageIds(paginateWidgets([m("m"), s("a")], metrics, 1000))).toEqual([["m", "a"]]);
    expect(paginateWidgets([], metrics, 500)).toEqual([]);
  });

  it("gives a row taller than the page a page of its own", () => {
    expect(pageIds(paginateWidgets([l("l"), s("a")], metrics, 50))).toEqual([["l"], ["a"]]);
  });

  it("lays each page out as the rows were in the full list", () => {
    const widgets = [s("a"), s("b"), s("c"), m("m")];
    const pages = paginateWidgets(widgets, metrics, 100);
    expect(pageIds(pages)).toEqual([["a", "b"], ["c"], ["m"]]);
    expect(pages.flatMap((page) => flowRows(page).map(ids))).toEqual(flowRows(widgets).map(ids));
  });

  it("carries a widget to the start of the page before or the end of the page after", () => {
    const widgets = [m("m"), s("a"), l("l"), s("b"), m("n")];
    const pages = paginateWidgets(widgets, metrics, 210);
    expect(pageIds(pages)).toEqual([["m", "a"], ["l"], ["b", "n"]]);
    expect(ids(moveToPage(widgets, pages, "l", -1))).toEqual(["l", "m", "a", "b", "n"]);
    expect(ids(moveToPage(widgets, pages, "l", 1))).toEqual(["m", "a", "b", "n", "l"]);
    expect(ids(moveToPage(widgets, pages, "a", 1))).toEqual(["m", "l", "a", "b", "n"]);
  });

  it("changes nothing past the first or last page, or for an unknown id", () => {
    const widgets = [m("m"), l("l")];
    const pages = paginateWidgets(widgets, metrics, 100);
    expect(ids(moveToPage(widgets, pages, "m", -1))).toEqual(["m", "l"]);
    expect(ids(moveToPage(widgets, pages, "l", 1))).toEqual(["m", "l"]);
    expect(ids(moveToPage(widgets, pages, "x", 1))).toEqual(["m", "l"]);
  });
});
