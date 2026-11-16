import type { Board, BoardTab } from '@evaos/contract'

/** The tab each board had picked, kept for the session; a board nobody picked on shows its first. */
const picked = new Map<string, string>()

export function pickTab(slug: string, id: string): void {
  picked.set(slug, id)
}

/** The tab to show: the one picked for this board, else the first (also when the picked one is gone). */
export function shownTab(board: Pick<Board, 'slug' | 'tabs'>): BoardTab | null {
  const tabs = board.tabs
  if (tabs === null || tabs.length === 0) return null
  return tabs.find((t) => t.id === picked.get(board.slug)) ?? tabs[0]!
}
