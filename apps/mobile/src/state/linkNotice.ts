/**
 * The short notice a `relay://` link leaves when it opened the nearest screen instead of the one it
 * names (`lib/appLinks.ts` `AppRoute.notice`). `seq` changes on every call so the same notice twice
 * shows twice; `LinkNotice` (root layout) draws and clears it.
 */
import { create } from "zustand";

interface LinkNoticeState {
  notice: string | null;
  seq: number;
  say: (notice: string) => void;
}

export const useLinkNotice = create<LinkNoticeState>((set) => ({
  notice: null,
  seq: 0,
  say: (notice) => {
    set((state) => ({ notice, seq: state.seq + 1 }));
  },
}));
