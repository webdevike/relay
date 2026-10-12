/**
 * Live view as the phone last heard it: the host's window list and the newest frame of the window
 * being watched. Not persisted; frames are replaced, never queued, so memory stays at one JPEG.
 */
import { create } from "zustand";
import type { ScreenError, ScreenWindow } from "@relay/protocol";

export interface ScreenFrameState {
  readonly windowId: number;
  /** `data:image/jpeg;base64,...`, ready for an `Image` source. */
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

export interface ScreenStore {
  /** null until the host answers `screen.list`. */
  windows: ScreenWindow[] | null;
  listError: ScreenError | null;
  frame: ScreenFrameState | null;
  /** Why the current watch stopped on the host's side; cleared by the next watch. */
  ended: ScreenError | null;
  /** Host cursor over the watched window, normalized (outside 0..1 when off it); null until known. */
  cursor: { x: number; y: number } | null;
  setList: (windows: ScreenWindow[], error: ScreenError | null) => void;
  setFrame: (frame: ScreenFrameState) => void;
  setEnded: (error: ScreenError) => void;
  setCursor: (x: number, y: number) => void;
  /** Forget the frame, cursor and any end reason, before a new watch or after leaving the view. */
  clearWatch: () => void;
}

export const useScreenStore = create<ScreenStore>((set) => ({
  windows: null,
  listError: null,
  frame: null,
  ended: null,
  cursor: null,
  setList: (windows, error) => {
    set({ windows, listError: error });
  },
  setFrame: (frame) => {
    set({ frame });
  },
  setEnded: (error) => {
    set({ ended: error });
  },
  setCursor: (x, y) => {
    set({ cursor: { x, y } });
  },
  clearWatch: () => {
    set({ frame: null, ended: null, cursor: null });
  },
}));
