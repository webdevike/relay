/**
 * The short line a save, copy or share of an image or video leaves ("Saved to Photos", or why it
 * failed). It clears itself after `MEDIA_NOTICE_MS`; `ui/MediaNotice` draws it at the root and
 * inside the full-screen viewers, whose native modals cover the root.
 */
import { create } from "zustand";

export const MEDIA_NOTICE_MS = 2600;

interface MediaNoticeState {
  notice: string | null;
  say: (notice: string) => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useMediaNotice = create<MediaNoticeState>((set) => ({
  notice: null,
  say: (notice) => {
    clearTimeout(timer);
    set({ notice });
    timer = setTimeout(() => {
      set({ notice: null });
    }, MEDIA_NOTICE_MS);
  },
}));
