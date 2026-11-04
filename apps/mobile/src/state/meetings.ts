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
  type LiveLine,
  type MeetingRecording,
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
  setAstra: (id: string, item: AstraItem) => void;
  clear: () => void;
}

export const useMeetingsStore = create<MeetingsStore>((set, get) => ({
  loaded: false,
  state: null,
  pages: {},
  setState: (state) => { set({ loaded: true, state }); },
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
  setPage: (snapshot) => { set({ pages: { ...get().pages, [snapshot.recording.id]: snapshot } }); },
  applyLive: (id, upsert) => {
    const page = get().pages[id];
    if (page !== undefined)
      set({
        pages: { ...get().pages, [id]: { ...page, lines: applyLiveLines(page.lines, upsert) } },
      });
  },
  setAstra: (id, item) => {
    const page = get().pages[id];
    if (page !== undefined) set({ pages: { ...get().pages, [id]: { ...page, astra: item } } });
  },
  clear: () => { set({ loaded: false, state: null, pages: {} }); },
}));

/** "Weekly Engineering Sync", or "Microsoft Teams call" for an untitled one. */
export function recordingTitle(r: Pick<MeetingRecording, "title" | "app">): string {
  return r.title ?? `${r.app} call`;
}
