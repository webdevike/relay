import { describe, expect, it } from "vitest";
import type { FeedItem } from "@relay/protocol";
import { feedImageUri, feedTags, visibleFeed } from "./feed";

const item = (id: string, tag?: string): FeedItem => ({ id, source: "HN", title: id, why: "", url: `https://x/${id}`, ts: 1, ...(tag === undefined ? {} : { tag }) });
const items = [item("a", "3d"), item("b", "game-dev"), item("c", "3d"), item("d")];

describe("visibleFeed", () => {
  it("keeps file order and drops skipped cards", () => {
    expect(visibleFeed(items, { b: "skip", c: "like" }, null).map((i) => i.id)).toEqual(["a", "c", "d"]);
  });

  it("filters to one interest", () => {
    expect(visibleFeed(items, {}, "3d").map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("feedTags", () => {
  it("lists each tag once, sorted, ignoring skipped cards", () => {
    expect(feedTags(items, {})).toEqual(["3d", "game-dev"]);
    expect(feedTags(items, { b: "skip" })).toEqual(["3d"]);
  });
});

describe("feedImageUri", () => {
  it("loads an https image directly and a cached thumbnail from the host", () => {
    expect(feedImageUri("https://i.ytimg.com/a.jpg", null)).toBe("https://i.ytimg.com/a.jpg");
    expect(feedImageUri("/feed/media/8cb259056a4c.jpg", "http://100.1.2.3:7817")).toBe("http://100.1.2.3:7817/feed/media/8cb259056a4c.jpg");
  });

  it("has no image for a thumbnail while no host is connected, or for a card without one", () => {
    expect(feedImageUri("/feed/media/8cb259056a4c.jpg", null)).toBeNull();
    expect(feedImageUri(undefined, "http://h")).toBeNull();
  });
});
