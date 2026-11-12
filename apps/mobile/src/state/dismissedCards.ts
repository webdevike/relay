/**
 * The status cards Isaac dismissed (see `lib/dismissedCards.ts` for the ids). With a host that
 * keeps them (`welcome.features` has "cards.dismissed") the host's set is the truth, shared with
 * Relay desktop: its `cards.dismissed` frame replaces `ids`, a dismissal shows at once and goes up.
 * `ids` is also kept on the phone, so a closed card stays closed across restarts before the host
 * has answered, and with an older host or none at all. A dismissal made while the host's set is
 * unknown (offline, before its first frame) is also `pending`; the next host frame takes those up,
 * once, and forgets them.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { withDismissed, withRestored } from "@/lib/dismissedCards";
import { fileStorage } from "./storage";

export interface DismissedCardsStore {
  /** Every dismissed card id: the host's set when known, else what this phone last knew. Persisted. */
  ids: string[];
  /** Dismissed here while the host's set was unknown, not yet sent. Persisted. */
  pending: string[];
  /** The connected host keeps dismissed cards. Not persisted. */
  hostUp: boolean;
  /** The host's set arrived on this connection, so a change can go up at once. Not persisted. */
  synced: boolean;
  setHostUp: (on: boolean) => void;
  /**
   * The host's set, replacing `ids`. Returns the pending dismissals the host lacks, now forgotten
   * here, for the caller to send up.
   */
  setHost: (ids: readonly string[]) => string[];
  /** Dismisses (`on`) or restores `key` here; the caller sends it when `synced`. */
  apply: (key: string, on: boolean) => void;
  /** The host's set is no longer known (another host, or a dropped connection). */
  clearHost: () => void;
}

export const useDismissedCardsStore = create<DismissedCardsStore>()(
  persist(
    (set, get) => ({
      ids: [],
      pending: [],
      hostUp: false,
      synced: false,
      setHostUp: (on) => {
        set({ hostUp: on });
      },
      setHost: (ids) => {
        const up = get().pending.filter((key) => !ids.includes(key));
        set({ ids: up.reduce(withDismissed, [...ids]), pending: [], synced: true });
        return up;
      },
      apply: (key, on) => {
        set((state) => ({
          ids: on ? withDismissed(state.ids, key) : withRestored(state.ids, key),
          pending: state.synced ? state.pending : on ? withDismissed(state.pending, key) : withRestored(state.pending, key),
        }));
      },
      clearHost: () => {
        set({ synced: false, hostUp: false });
      },
    }),
    {
      name: "relay-dismissed-cards",
      storage: createJSONStorage(() => fileStorage),
      partialize: (state) => ({ ids: state.ids, pending: state.pending }),
    },
  ),
);
