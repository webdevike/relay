import { beforeEach, describe, expect, it, vi } from "vitest";

const written = vi.hoisted(() => new Map<string, string>());
vi.mock("./storage", () => ({
  fileStorage: {
    getItem: (name: string) => Promise.resolve(written.get(name) ?? null),
    setItem: (name: string, value: string) => {
      written.set(name, value);
    },
    removeItem: (name: string) => {
      written.delete(name);
    },
  },
}));

import { MAX_BOOKMARKS, bookmarksOf, isTurnKey, useBookmarksStore } from "./bookmarks";

const store = () => useBookmarksStore.getState();

beforeEach(() => {
  useBookmarksStore.setState({ local: {}, host: {}, hostUp: false });
  written.clear();
});

describe("bookmarks on this phone", () => {
  it("toggles a turn on and off per thread, forgetting an emptied thread", () => {
    store().toggleLocal("assistant:nova", "user@1");
    store().toggleLocal("assistant:nova", "assistant@2");
    store().toggleLocal("session:s1", "user@1");
    expect(store().local).toEqual({ "assistant:nova": ["user@1", "assistant@2"], "session:s1": ["user@1"] });
    store().toggleLocal("assistant:nova", "user@1");
    store().toggleLocal("session:s1", "user@1");
    expect(store().local).toEqual({ "assistant:nova": ["assistant@2"] });
  });

  it("keeps the newest MAX_BOOKMARKS of a thread", () => {
    for (let i = 0; i < MAX_BOOKMARKS + 3; i++) store().toggleLocal("session:s", `user@${i}`);
    const keys = store().local["session:s"] ?? [];
    expect(keys).toHaveLength(MAX_BOOKMARKS);
    expect(keys[0]).toBe("user@3");
  });

  it("persists only the phone's own, so a host's set never outlives its connection", () => {
    store().toggleLocal("assistant:nova", "user@1");
    store().setHost("session:s1", ["user@9"]);
    const saved = JSON.parse(written.get("relay-bookmarks") ?? "{}") as { state?: Record<string, unknown> };
    expect(saved.state).toEqual({ local: { "assistant:nova": ["user@1"] } });
  });
});

describe("bookmarks on the host", () => {
  it("shows the host's set over this phone's for that thread", () => {
    store().toggleLocal("assistant:nova", "user@1");
    store().setHost("assistant:nova", ["user@5"]);
    expect(bookmarksOf(store(), "assistant:nova")).toEqual(["user@5"]);
    expect(bookmarksOf(store(), "session:other")).toEqual([]);
  });

  it("hands back this phone's bookmarks the host lacks, once, and forgets them", () => {
    store().toggleLocal("session:s1", "user@1");
    store().toggleLocal("session:s1", "user@2");
    store().toggleLocal("session:s1", "row-3");
    store().toggleLocal("session:s2", "user@5");
    expect(store().setHost("session:s1", ["user@1", "assistant@8"])).toEqual(["user@2"]);
    expect(store().local).toEqual({ "session:s2": ["user@5"] });
    expect(store().setHost("session:s1", ["user@1", "assistant@8", "user@2"])).toEqual([]);
  });

  it("applies a toggle at once and never twice", () => {
    store().setHost("session:s1", ["user@1"]);
    store().setHostLocal("session:s1", "user@2", true);
    store().setHostLocal("session:s1", "user@2", true);
    store().setHostLocal("session:s1", "user@1", false);
    expect(store().host["session:s1"]).toEqual(["user@2"]);
  });

  it("clears what the host said, keeping the phone's own", () => {
    store().toggleLocal("session:s2", "user@5");
    store().setHost("session:s1", ["user@1"]);
    store().setHostUp(true);
    store().clearHost();
    expect(store().host).toEqual({});
    expect(store().hostUp).toBe(false);
    expect(store().local).toEqual({ "session:s2": ["user@5"] });
  });
});

describe("isTurnKey", () => {
  it("accepts only a reaction key", () => {
    expect(isTurnKey("user@1792486874000")).toBe(true);
    expect(isTurnKey("assistant@1")).toBe(true);
    expect(isTurnKey("row-3")).toBe(false);
    expect(isTurnKey("tool@1")).toBe(false);
  });
});
