/**
 * Dashboards as the host last pushed them: a `board.snapshot` replaces the set, a `board.delta`
 * swaps in or removes one board. Not persisted; the host is the source of truth and re-sends the
 * snapshot on every (re)subscribe.
 */
import { create } from "zustand";
import type { Board } from "@relay/protocol";

export interface BoardsStore {
  boards: Board[];
  setAll: (boards: Board[]) => void;
  upsert: (board: Board) => void;
  remove: (slug: string) => void;
}

export const useBoardsStore = create<BoardsStore>((set) => ({
  boards: [],
  setAll: (boards) => {
    set({ boards });
  },
  upsert: (board) => {
    set((state) => {
      const i = state.boards.findIndex((b) => b.slug === board.slug);
      if (i === -1) return { boards: [...state.boards, board] };
      const boards = state.boards.slice();
      boards[i] = board;
      return { boards };
    });
  },
  remove: (slug) => {
    set((state) => ({ boards: state.boards.filter((b) => b.slug !== slug) }));
  },
}));
