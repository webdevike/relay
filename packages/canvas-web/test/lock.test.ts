import { describe, expect, it, vi } from "vitest";
import {
  canEdit,
  createLockStore,
  flowInteraction,
  lockKey,
  readLocked,
  writeLocked,
} from "../src/lock";

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("lock persistence", () => {
  it("starts unlocked and remembers the state per board", () => {
    const s = storage();
    const a = createLockStore(s, "board-a");
    expect(a.get()).toBe(false);
    a.toggle();
    expect(a.get()).toBe(true);
    expect(s.map.get(lockKey("board-a"))).toBe("1");
    expect(createLockStore(s, "board-a").get()).toBe(true);
    expect(createLockStore(s, "board-b").get()).toBe(false);
  });

  it("unlocking clears the saved flag", () => {
    const s = storage({ [lockKey("x")]: "1" });
    const store = createLockStore(s, "x");
    expect(store.get()).toBe(true);
    store.toggle();
    expect(store.get()).toBe(false);
    expect(s.map.has(lockKey("x"))).toBe(false);
  });

  it("notifies subscribers only on a change", () => {
    const store = createLockStore(storage(), "x");
    const cb = vi.fn();
    const off = store.subscribe(cb);
    store.set(false);
    expect(cb).not.toHaveBeenCalled();
    store.set(true);
    store.toggle();
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    store.toggle();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("works without storage or with storage that throws", () => {
    const store = createLockStore(null, "x");
    store.toggle();
    expect(store.get()).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLocked(broken, "x")).toBe(false);
    expect(() => writeLocked(broken, "x", true)).not.toThrow();
    const s = createLockStore(broken, "x");
    s.toggle();
    expect(s.get()).toBe(true);
  });
});

describe("what a lock allows", () => {
  it("blocks editing when locked or ended", () => {
    expect(canEdit({ locked: false, ended: false })).toBe(true);
    expect(canEdit({ locked: true, ended: false })).toBe(false);
    expect(canEdit({ locked: false, ended: true })).toBe(false);
  });

  it("locked: no drag, select, connect or marquee; drag pans", () => {
    expect(flowInteraction(true, false)).toEqual({
      nodesDraggable: false,
      nodesConnectable: false,
      elementsSelectable: false,
      selectionOnDrag: false,
      panOnDrag: true,
    });
    expect(flowInteraction(true, true).nodesDraggable).toBe(false);
  });

  it("unlocked keeps the existing mouse and touch behaviour", () => {
    expect(flowInteraction(false, false)).toEqual({
      nodesDraggable: true,
      nodesConnectable: true,
      elementsSelectable: true,
      selectionOnDrag: true,
      panOnDrag: [1, 2],
    });
    const touch = flowInteraction(false, true);
    expect(touch.nodesConnectable).toBe(false);
    expect(touch.selectionOnDrag).toBe(false);
    expect(touch.panOnDrag).toBe(true);
  });
});
