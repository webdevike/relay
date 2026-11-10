import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedService, imageOf } from "../src/feed/service";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feed-"));
  mkdirSync(join(dir, "media"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, source: "HN", title: id, why: "w", url: `https://x/${id}`, ts: 1, ...extra });

describe("feed images", () => {
  it("passes https, maps cached thumbnails to the host path, drops anything else", () => {
    expect(imageOf("https://i.ytimg.com/a.jpg")).toBe("https://i.ytimg.com/a.jpg");
    expect(imageOf("local:media/8cb259056a4c.jpg")).toBe("/feed/media/8cb259056a4c.jpg");
    expect(imageOf("local:media/../../etc/passwd")).toBeUndefined();
    expect(imageOf("http://insecure/a.jpg")).toBeUndefined();
    expect(imageOf("data:image/png;base64,AAAA")).toBeUndefined();
  });

  it("serves only a bare cached file name", () => {
    writeFileSync(join(dir, "media", "8cb259056a4c.jpg"), "jpg");
    const feed = new FeedService(dir);
    expect(feed.openMedia("8cb259056a4c.jpg")?.mimeType).toBe("image/jpeg");
    expect(feed.openMedia("../feed.json")).toBeNull();
    expect(feed.openMedia("missing00.jpg")).toBeNull();
  });
});

describe("FeedService", () => {
  it("is empty without a feed file", () => {
    expect(new FeedService(dir).snapshot()).toEqual({ generatedAt: null, items: [], acted: {} });
  });

  it("lists cards in file order, rewrites thumbnails, hides skipped ones and reports the newest action per card", () => {
    writeFileSync(
      join(dir, "feed.json"),
      JSON.stringify({ generatedAt: "t", items: [item("a", { image: "local:media/8cb259056a4c.jpg" }), item("b"), item("c"), { nope: true }] }),
    );
    writeFileSync(
      join(dir, "signals.jsonl"),
      [{ id: "a", action: "like" }, { id: "b", action: "skip" }, { id: "a", action: "save" }].map((s) => JSON.stringify(s)).join("\n") + "\n{torn",
    );
    const snap = new FeedService(dir).snapshot();
    expect(snap.generatedAt).toBe("t");
    expect(snap.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(snap.items[0]?.image).toBe("/feed/media/8cb259056a4c.jpg");
    expect(snap.acted).toEqual({ a: "save", b: "skip" });
  });

  it("appends a signal the next snapshot sees", () => {
    writeFileSync(join(dir, "feed.json"), JSON.stringify({ items: [item("a")] }));
    const feed = new FeedService(dir);
    feed.signal("a", "like", "A", "HN");
    const line = JSON.parse(readFileSync(join(dir, "signals.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ id: "a", action: "like", title: "A", source: "HN" });
    expect(feed.snapshot().acted).toEqual({ a: "like" });
  });
});
