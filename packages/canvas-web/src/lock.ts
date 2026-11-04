// Read-only lock for this viewer: pan and zoom still work, nothing on the board can be moved,
// resized, edited, deleted or grouped by hand. It is never written to the doc (other viewers and
// agents keep editing); each board remembers its own state in localStorage, keyed by the room slug.

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const LOCK_STORAGE_PREFIX = "relay.canvas.locked.";

export function lockKey(slug: string): string {
  return `${LOCK_STORAGE_PREFIX}${slug}`;
}

export function readLocked(storage: StorageLike | null, slug: string): boolean {
  try {
    return storage?.getItem(lockKey(slug)) === "1";
  } catch {
    return false;
  }
}

export function writeLocked(storage: StorageLike | null, slug: string, locked: boolean): void {
  try {
    if (locked) storage?.setItem(lockKey(slug), "1");
    else storage?.removeItem(lockKey(slug));
  } catch {
    // Blocked storage: the lock then lasts for this page only.
  }
}

/** Whether the human may change the board: the session is open and the viewer has not locked it. */
export function canEdit(state: { locked: boolean; ended: boolean }): boolean {
  return !state.locked && !state.ended;
}

/** The React Flow switches for a lock state; touch keeps its own pan-on-drag and selection rules. */
export function flowInteraction(locked: boolean, touch: boolean) {
  return {
    nodesDraggable: !locked,
    nodesConnectable: !locked && !touch,
    elementsSelectable: !locked,
    selectionOnDrag: !locked && !touch,
    panOnDrag: locked || touch ? true : [1, 2],
  } as const;
}

export interface LockStore {
  get(): boolean;
  set(locked: boolean): void;
  toggle(): void;
  subscribe(cb: () => void): () => void;
}

export function createLockStore(storage: StorageLike | null, slug: string): LockStore {
  let locked = readLocked(storage, slug);
  const subs = new Set<() => void>();
  const set = (next: boolean) => {
    if (next === locked) return;
    locked = next;
    writeLocked(storage, slug, next);
    for (const cb of subs) cb();
  };
  return {
    get: () => locked,
    set,
    toggle: () => set(!locked),
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
