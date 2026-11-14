import { describe, expect, it, vi } from "vitest";
import { isBlankSnapshot, MAX_POSTERS, posterName, postersOverCap } from "./modelPosters";

vi.mock("expo-file-system", () => ({ Directory: vi.fn(), File: vi.fn(), Paths: { cache: "/cache" } }));
vi.mock("@/dictation/skia", () => ({ loadSkia: () => null }));

/** A 4x4 RGBA image from a function of the pixel index. */
const image = (pixel: (i: number) => [number, number, number, number]) => Uint8Array.from(Array.from({ length: 16 }, (_, i) => pixel(i)).flat());

describe("isBlankSnapshot", () => {
  it("rejects a snapshot with nothing in it: transparent, or one flat color", () => {
    expect(isBlankSnapshot(image(() => [0, 0, 0, 0]))).toBe(true);
    expect(isBlankSnapshot(image(() => [0, 0, 0, 255]))).toBe(true); // a Metal layer read back as black
    expect(isBlankSnapshot(image(() => [40, 40, 44, 255]))).toBe(true);
    expect(isBlankSnapshot(new Uint8Array(0))).toBe(true);
  });

  it("keeps a model on a transparent background, even a dark one", () => {
    expect(isBlankSnapshot(image((i) => (i % 4 === 1 ? [200, 120, 80, 255] : [0, 0, 0, 0])))).toBe(false);
    expect(isBlankSnapshot(image((i) => (i < 6 ? [10, 10, 10, 255] : [0, 0, 0, 0])))).toBe(false);
  });

  it("keeps an opaque render with shading", () => {
    expect(isBlankSnapshot(image((i) => [i * 12, i * 10, i * 8, 255]))).toBe(false);
  });
});

describe("posterName", () => {
  it("is the same for the same src and differs between srcs", () => {
    const a = "/drops/abc/" + "ab".repeat(32);
    expect(posterName(a)).toBe(posterName(a));
    expect(posterName(a)).not.toBe(posterName(a.replace("abc", "abd")));
    expect(posterName(a)).toMatch(/^[0-9a-f]{8}-\d+\.jpg$/);
  });
});

describe("postersOverCap", () => {
  it("drops the oldest posters past the cap and nothing at or under it", () => {
    const files = Array.from({ length: MAX_POSTERS + 2 }, (_, i) => ({ name: `p${String(i)}.png`, modified: 1000 + i }));
    expect(postersOverCap(files)).toEqual(["p1.png", "p0.png"]);
    expect(postersOverCap(files.slice(0, MAX_POSTERS))).toEqual([]);
  });
});
