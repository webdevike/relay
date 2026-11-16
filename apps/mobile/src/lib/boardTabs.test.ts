import { describe, expect, it } from "vitest";
import type { Board, BoardWidget } from "@relay/protocol";
import { boardSubtitle, pickBoardTab, shownBoardTab } from "./boardTabs";

const tile = (id: string): BoardWidget => ({ id, span: 12, spec: { widget: "divider" } });
const board = (over: Partial<Board> = {}): Board => ({
  slug: "lists",
  title: "Lists",
  widgets: [],
  updatedAt: "2026-11-16T10:00:00.000Z",
  ...over,
});
const tabbed = board({
  tabs: [
    { id: "deals", title: "Deals", widgets: [tile("a"), tile("b")] },
    { id: "wife", title: "Wife's list", widgets: [tile("c")] },
  ],
});

describe("shownBoardTab", () => {
  it("shows the first tab until one is picked, the picked one after, and the first again when it goes", () => {
    expect(shownBoardTab(tabbed)?.id).toBe("deals");
    pickBoardTab("lists", "wife");
    expect(shownBoardTab(tabbed)?.id).toBe("wife");
    expect(shownBoardTab({ slug: "lists", tabs: [tabbed.tabs![0]!] })?.id).toBe("deals");
  });

  it("has no tab on an untabbed board", () => {
    expect(shownBoardTab(board({ widgets: [tile("a")] }))).toBeUndefined();
  });
});

describe("boardSubtitle", () => {
  it("counts every tile, says how many tabs, and names the workspace", () => {
    expect(boardSubtitle(board({ widgets: [tile("a")] }))).toBe("1 tiles");
    expect(boardSubtitle({ ...tabbed, workspace: "Personal" })).toBe("3 tiles · 2 tabs · Personal");
  });
});
