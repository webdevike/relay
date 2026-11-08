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
 * A mount takes a free slot only for a model no earlier mount has shown (a new model in a thread
 * still appears spinning); every other mount shows a "View in 3D" card, and a tap hands the slot to
 * that model.
 */
import { useCallback, useEffect, useId } from "react";
import { create } from "zustand";

interface LiveModelStore {
  /** Id of the model view that may hold a native 3D view, or null when none does. */
  slot: string | null;
  /** Model URL -> the first view that mounted it this run (a StrictMode re-run of that same view still counts as first). */
  seen: ReadonlyMap<string, string>;
  /** A mount (`tap` false) takes a free slot for a model no other view has mounted; a tap always takes it. */
  claim: (id: string, uri: string, tap: boolean) => void;
  /** Only the holder frees the slot. */
  release: (id: string) => void;
}

export const useLiveModelStore = create<LiveModelStore>((set) => ({
  slot: null,
  seen: new Map(),
  claim: (id, uri, tap) => {
    set(({ slot, seen }) => {
      if (tap) return { slot: id };
      const first = seen.get(uri);
      const next = first === undefined ? { seen: new Map(seen).set(uri, id) } : {};
      return slot === null && (first === undefined || first === id) ? { ...next, slot: id } : next;
    });
  },
  release: (id) => {
    set(({ slot }) => (slot === id ? { slot: null } : {}));
  },
}));

/** Whether this model view may draw its native 3D view now, and the tap that makes it the live one. */
export function useLiveModel(uri: string): { live: boolean; activate: () => void } {
  const id = useId();
  const live = useLiveModelStore((state) => state.slot === id);
  useEffect(() => {
    useLiveModelStore.getState().claim(id, uri, false);
    return () => {
      useLiveModelStore.getState().release(id);
    };
  }, [id, uri]);
  const activate = useCallback(() => {
    useLiveModelStore.getState().claim(id, uri, true);
  }, [id, uri]);
  return { live, activate };
}
