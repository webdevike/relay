/**
 * At most one native 3D view is live in the app at a time, and only a model the app has never shown
 * before loads on its own. Each SceneKit view holds its own copy of its model (the GLB, the GLTFKit2
 * asset, SceneKit geometry, GPU buffers, 4x MSAA drawables), an auto-rotating one redraws at the
 * display rate, and SceneKit keeps tens of MB of GPU memory for every model load even after the
 * view is gone. The thread list keeps rows mounted well off screen and remounts them as Isaac
 * scrolls or reopens a thread, so a thread with several scanned-room models kept them all live,
 * reloaded them on every remount, and iOS killed Relay at its 3.5 GB memory limit (2026-11-05 and
 * 2026-11-08).
 *
 * A mount takes the slot only for a model no earlier mount has shown (a new model in a thread
 * still appears spinning), and the newest message's model wins: it takes the slot from a model of
 * an older message that took it on its own, never from one Isaac tapped. Every other mount shows a
 * "View in 3D" card, and a tap hands the slot to that model.
 */
import { createContext, useCallback, useContext, useEffect, useId } from "react";
import { create } from "zustand";

/** The message's time (epoch ms) for the models inside it; the newest message's model loads. */
export const ModelRank = createContext(0);

interface Holder {
  id: string;
  rank: number;
  /** Isaac tapped it: no newer model takes the slot from it. */
  tapped: boolean;
}

interface LiveModelStore {
  /** The model view that may hold a native 3D view, or null when none does. */
  slot: Holder | null;
  /** Model URL -> the first view that mounted it this run (a StrictMode re-run of that same view still counts as first). */
  seen: ReadonlyMap<string, string>;
  /**
   * A mount (`tap` false) takes the slot for a model no other view has mounted, when the slot is
   * free or its holder is an older message's model that took it on its own; a tap always takes it.
   */
  claim: (id: string, uri: string, tap: boolean, rank: number) => void;
  /** Only the holder frees the slot. */
  release: (id: string) => void;
}

export const useLiveModelStore = create<LiveModelStore>((set) => ({
  slot: null,
  seen: new Map(),
  claim: (id, uri, tap, rank) => {
    set(({ slot, seen }) => {
      if (tap) return { slot: { id, rank, tapped: true } };
      const first = seen.get(uri);
      const next = first === undefined ? { seen: new Map(seen).set(uri, id) } : {};
      const fresh = first === undefined || first === id;
      const open = slot === null || slot.id === id || (!slot.tapped && slot.rank < rank);
      return fresh && open ? { ...next, slot: { id, rank, tapped: false } } : next;
    });
  },
  release: (id) => {
    set(({ slot }) => (slot?.id === id ? { slot: null } : {}));
  },
}));

/** Whether this model view may draw its native 3D view now, and the tap that makes it the live one. */
export function useLiveModel(uri: string): { live: boolean; activate: () => void } {
  const id = useId();
  const rank = useContext(ModelRank);
  const live = useLiveModelStore((state) => state.slot?.id === id);
  useEffect(() => {
    useLiveModelStore.getState().claim(id, uri, false, rank);
    return () => {
      useLiveModelStore.getState().release(id);
    };
  }, [id, uri, rank]);
  const activate = useCallback(() => {
    useLiveModelStore.getState().claim(id, uri, true, rank);
  }, [id, uri, rank]);
  return { live, activate };
}
