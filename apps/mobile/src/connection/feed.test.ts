import { beforeEach, describe, expect, it } from "vitest";
import { useFeedStore } from "@/state/feed";
import { createFeedFrameRouter } from "./feed";

beforeEach(() => {
  useFeedStore.setState({ items: null, generatedAt: null, acted: {} });
});

describe("feed.snapshot", () => {
  it("replaces the cards and what Isaac already did with them", () => {
    const route = createFeedFrameRouter(useFeedStore.getState());
    useFeedStore.getState().actLocal("a", "like");
    route({ t: "feed.snapshot", generatedAt: "t", items: [{ id: "a", source: "HN", title: "A", why: "", url: "https://x", ts: 1 }], acted: { a: "save" } });
    expect(useFeedStore.getState().items?.map((i) => i.id)).toEqual(["a"]);
    expect(useFeedStore.getState().acted).toEqual({ a: "save" });
  });
});
