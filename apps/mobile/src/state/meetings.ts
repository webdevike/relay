/**
 * Meetings as the phone last heard them from the host: Relay's recordings (a call in progress on
 * top), the records with their digest, and the pages opened (a recording's live transcript and
 * Astra's session about it). Not persisted: the driver asks `meetings.list` on every welcome and a
 * page asks for its snapshot when it opens.
 */
import { create } from "zustand";
import {
  applyLiveLines,
  type AstraItem,
  type KeyMoment,
  type LiveLine,
  type MeetingRecording,
  type MeetingShot,
  type MeetingSnapshot,
  type MeetingsState,
} from "@relay/protocol";

export interface MeetingsStore {
  /** False until the first `meetings.state` from this host. */
  loaded: boolean;
  state: MeetingsState | null;
  /** Opened recordings by id. */
  pages: Record<string, MeetingSnapshot>;
  setState: (state: MeetingsState) => void;
  upsertRecording: (recording: MeetingRecording) => void;
  setPage: (snapshot: MeetingSnapshot) => void;
  applyLive: (id: string, upsert: readonly LiveLine[]) => void;
  /** The page's key moments: the host always sends the whole list. */
  setMoments: (id: string, moments: readonly KeyMoment[]) => void;
  /** One more screen snapshot (or one the page already holds, from its snapshot). */
  addShot: (id: string, shot: MeetingShot) => void;
  setAstra: (id: string, item: AstraItem) => void;
  clear: () => void;
}

export const useMeetingsStore = create<MeetingsStore>((set, get) => ({
  loaded: false,
  state: null,
  pages: {},
  setState: (state) => {
    set({ loaded: true, state });
  },
  upsertRecording: (recording) => {
    const { state, pages } = get();
    const page = pages[recording.id];
    set({
      ...(state === null
        ? {}
        : {
            state: {
              ...state,
              recordings: [
                recording,
                ...state.recordings.filter((r) => r.id !== recording.id),
              ].sort((a, b) => b.startedAt - a.startedAt),
            },
          }),
      ...(page === undefined
        ? {}
        : { pages: { ...pages, [recording.id]: { ...page, recording } } }),
    });
  },
  setPage: (snapshot) => {
    set({ pages: { ...get().pages, [snapshot.recording.id]: snapshot } });
  },
  applyLive: (id, upsert) => {
    const page = get().pages[id];
    if (page !== undefined)
      set({
        pages: { ...get().pages, [id]: { ...page, lines: applyLiveLines(page.lines, upsert) } },
      });
  },
  setMoments: (id, moments) => {
    const page = get().pages[id];
    if (page !== undefined)
      set({ pages: { ...get().pages, [id]: { ...page, moments: [...moments] } } });
  },
  addShot: (id, shot) => {
    const page = get().pages[id];
    if (page === undefined) return;
    // A shot that also came in the snapshot is replaced, so the list stays one per number in order.
    const shots = [...page.shots.filter((s) => s.n !== shot.n), shot].sort((a, b) => a.n - b.n);
    set({ pages: { ...get().pages, [id]: { ...page, shots } } });
  },
  setAstra: (id, item) => {
    const page = get().pages[id];
    if (page !== undefined) set({ pages: { ...get().pages, [id]: { ...page, astra: item } } });
  },
  clear: () => {
    set({ loaded: false, state: null, pages: {} });
  },
}));

/** "Weekly Engineering Sync", or "Microsoft Teams call" for an untitled one. */
export function recordingTitle(r: Pick<MeetingRecording, "title" | "app">): string {
  return r.title ?? `${r.app} call`;
}
