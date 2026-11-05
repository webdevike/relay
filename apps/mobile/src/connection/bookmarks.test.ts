import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/storage", () => ({
  fileStorage: { getItem: () => Promise.resolve(null), setItem: () => undefined, removeItem: () => undefined },
}));

import { useBookmarksStore } from "@/state/bookmarks";
import { createBookmarkFrameRouter, type BookmarkFrameRouter } from "./bookmarks";

let route: BookmarkFrameRouter;
let sentUp: [string, string][];

beforeEach(() => {
  useBookmarksStore.setState({ local: {}, host: {}, hostUp: false });
  sentUp = [];
  route = createBookmarkFrameRouter(useBookmarksStore.getState(), (thread, key) => void sentUp.push([thread, key]));
});

const welcome = (features?: string[]) =>
  ({ t: "welcome", state: { agents: { rev: 0, sessions: [] } }, ...(features === undefined ? {} : { features }) }) as never;

describe("welcome", () => {
  it("says whether the host keeps bookmarks, every time", () => {
    route(welcome(["query", "bookmarks"]));
    expect(useBookmarksStore.getState().hostUp).toBe(true);
    route(welcome(["query"]));
    expect(useBookmarksStore.getState().hostUp).toBe(false);
    route(welcome());
    expect(useBookmarksStore.getState().hostUp).toBe(false);
  });
});

describe("bookmarks.snapshot", () => {
  it("replaces that thread's set and leaves the others alone", () => {
    route({ t: "bookmarks.snapshot", thread: "assistant:nova", messages: ["user@1"] });
    route({ t: "bookmarks.snapshot", thread: "session:abc", messages: ["assistant@2"] });
    route({ t: "bookmarks.snapshot", thread: "assistant:nova", messages: [] });
    expect(useBookmarksStore.getState().host).toEqual({ "assistant:nova": [], "session:abc": ["assistant@2"] });
  });

  it("sends the phone's own bookmarks up with the thread's first snapshot, and only then", () => {
    useBookmarksStore.getState().toggleLocal("assistant:nova", "user@1");
    useBookmarksStore.getState().toggleLocal("assistant:nova", "user@2");
    route({ t: "bookmarks.snapshot", thread: "assistant:nova", messages: ["user@1"] });
    route({ t: "bookmarks.snapshot", thread: "assistant:nova", messages: ["user@1"] });
    expect(sentUp).toEqual([["assistant:nova", "user@2"]]);
  });
});

describe("other frames", () => {
  it("leave bookmarks alone", () => {
    route({ t: "bookmarks.snapshot", thread: "assistant:nova", messages: ["user@1"] });
    route({ t: "pong", ts: 1, serverTs: 2 });
    expect(useBookmarksStore.getState().host).toEqual({ "assistant:nova": ["user@1"] });
  });
});
