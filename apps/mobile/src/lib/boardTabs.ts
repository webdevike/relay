import { boardWidgets, type Board, type BoardTab } from "@relay/protocol";

/** Past this many tabs the tab row scrolls sideways instead of squeezing them equal-width. */
export const SCROLL_TABS_ABOVE = 4;

/** The tab each board had picked, for this app session. */
const picked: Record<string, string> = {};

export function pickBoardTab(slug: string, id: string): void {
  picked[slug] = id;
}

/** The tab to show: the one picked for this board, else the first (also when the picked one is gone). */
export function shownBoardTab(board: Pick<Board, "slug" | "tabs">): BoardTab | undefined {
  const tabs = board.tabs;
  if (tabs === undefined || tabs.length === 0) return undefined;
  return tabs.find((t) => t.id === picked[board.slug]) ?? tabs[0];
}

/** The boards list's second line: "7 tiles", "7 tiles · 3 tabs", then the workspace. */
export function boardSubtitle(board: Board): string {
  const tabs = board.tabs;
  const parts = [`${boardWidgets(board).length} tiles`];
  if (tabs !== undefined) parts.push(`${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`);
  if (board.workspace) parts.push(board.workspace);
  return parts.join(" · ");
}
