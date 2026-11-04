import { useSyncExternalStore } from "react";
import { createLockStore } from "./lock";
import { env } from "./room";

let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  // Blocked storage: the lock then lasts for this page only.
}

/** This viewer's lock for this board. */
export const pageLock = createLockStore(storage, env.slug);

export function useLocked(): boolean {
  return useSyncExternalStore(pageLock.subscribe, pageLock.get);
}
