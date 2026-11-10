import { describe, expect, it, vi } from "vitest";
import { createImageCache } from "./images";

const fetcher = (answers: Record<string, string | null> = {}) =>
  vi.fn((_room: string, path: string): Promise<string | null> => Promise.resolve(path in answers ? (answers[path] ?? null) : `data:${path}`));

describe("image cache", () => {
  it("asks the host once and serves the data URL from memory after", async () => {
    const fetch = fetcher();
    const cache = createImageCache(fetch);
    expect(cache.peek("r", "/a.png", 512)).toBeUndefined();
    expect(await cache.load("r", "/a.png", 512)).toBe("data:/a.png");
    expect(await cache.load("r", "/a.png", 512)).toBe("data:/a.png");
    expect(cache.peek("r", "/a.png", 512)).toBe("data:/a.png");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps sizes and rooms apart", async () => {
    const fetch = fetcher();
    const cache = createImageCache(fetch);
    await cache.load("r", "/a.png", 512);
    await cache.load("r", "/a.png", 2048);
    await cache.load("other", "/a.png", 512);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shares a request already in flight", async () => {
    const fetch = fetcher();
    const cache = createImageCache(fetch);
    const [a, b] = await Promise.all([cache.load("r", "/a.png", 512), cache.load("r", "/a.png", 512)]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used image past its limit", async () => {
    const fetch = fetcher();
    const cache = createImageCache(fetch, 2);
    await cache.load("r", "/1", 64);
    await cache.load("r", "/2", 64);
    cache.peek("r", "/1", 64);
    await cache.load("r", "/3", 64);
    expect(cache.peek("r", "/2", 64)).toBeUndefined();
    expect(cache.peek("r", "/1", 64)).toBe("data:/1");
    expect(cache.peek("r", "/3", 64)).toBe("data:/3");
  });

  it("does not keep a failure, so the next look asks again", async () => {
    const fetch = fetcher({ "/bad": null });
    const cache = createImageCache(fetch);
    expect(await cache.load("r", "/bad", 64)).toBeNull();
    expect(await cache.load("r", "/bad", 64)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats a fetcher that throws as a failure", async () => {
    const cache = createImageCache(() => Promise.reject(new Error("boom")));
    expect(await cache.load("r", "/a", 64)).toBeNull();
  });
});
