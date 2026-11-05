/**
 * Bookmarked chat turns by thread (`assistant:<id>` or `session:<id>`), each a turn key (the
 * reaction key of the bubble it starts at: the same on every device).
 *
 * With a host that keeps bookmarks (`welcome.features` has "bookmarks") the host owns them: its
 * `bookmarks.snapshot` arrives when a screen shows the thread (`host`, not persisted), a toggle
 * shows at once and goes up. Without one (an older host, not connected) they live on the phone
 * (`local`, persisted), and the first host snapshot of a thread takes this phone's up (`take`), once.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { fileStorage } from "./storage";

/** Most bookmarks kept per thread; the oldest go first (the host's own cap). */
export const MAX_BOOKMARKS = 500;

export interface BookmarksStore {
  /** On this phone, for threads without a host that keeps bookmarks. Persisted. */
  local: Record<string, string[]>;
  /** The host's bookmarks of each thread it has answered for. Not persisted. */
  host: Record<string, string[]>;
  /** The connected host keeps bookmarks. Not persisted. */
  hostUp: boolean;
  setHostUp: (on: boolean) => void;
  /**
   * The host's snapshot of `thread`, replacing what was shown. Returns the phone's own bookmarks of
   * the thread the host does not have, now forgotten here, for the caller to send up.
   */
  setHost: (thread: string, keys: readonly string[]) => string[];
  /** Optimistic: turn `key` of `thread` marked or unmarked on the host (the next snapshot is authoritative). */
  setHostLocal: (thread: string, key: string, on: boolean) => void;
  /** Marks or unmarks turn `key` of `thread` on this phone. */
  toggleLocal: (thread: string, key: string) => void;
  /** Forget everything the host said (another host, or a dropped connection). */
  clearHost: () => void;
}

const REACTION_KEY = /^(?:user|assistant)@\d+$/;

/** Whether the host can name turn `key`. */
export function isTurnKey(key: string): boolean {
  return REACTION_KEY.test(key);
}

function toggled(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key].slice(-MAX_BOOKMARKS);
}

function without(map: Record<string, string[]>, thread: string): Record<string, string[]> {
  return Object.fromEntries(Object.entries(map).filter(([other]) => other !== thread));
}

export const useBookmarksStore = create<BookmarksStore>()(
  persist(
    (set, get) => ({
      local: {},
      host: {},
      hostUp: false,
      setHostUp: (on) => {
        set({ hostUp: on });
      },
      setHost: (thread, keys) => {
        const mine = get().local[thread] ?? [];
        const up = mine.filter((k) => !keys.includes(k) && isTurnKey(k));
        set((state) => ({
          host: { ...state.host, [thread]: [...keys] },
          local: mine.length > 0 ? without(state.local, thread) : state.local,
        }));
        return up;
      },
      setHostLocal: (thread, key, on) => {
        set((state) => {
          const have = state.host[thread] ?? [];
          if (have.includes(key) === on) return {};
          return { host: { ...state.host, [thread]: toggled(have, key) } };
        });
      },
      toggleLocal: (thread, key) => {
        set((state) => {
          const keys = toggled(state.local[thread] ?? [], key);
          return {
            local:
              keys.length === 0 ? without(state.local, thread) : { ...state.local, [thread]: keys },
          };
        });
      },
      clearHost: () => {
        set({ host: {}, hostUp: false });
      },
    }),
    {
      name: "relay-bookmarks",
      storage: createJSONStorage(() => fileStorage),
      // Only the phone's own bookmarks outlive the app; the host's come back with its snapshots.
      partialize: (state) => ({ local: state.local }),
    },
  ),
);

const NONE: readonly string[] = [];

/** The bookmarked turn keys of `thread`: the host's when it keeps them, else this phone's. */
export function bookmarksOf(
  state: Pick<BookmarksStore, "local" | "host">,
  thread: string,
): readonly string[] {
  return state.host[thread] ?? state.local[thread] ?? NONE;
}
