import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Rect } from "@/lib/liveModel";
import { capturePoster, isBlankSnapshot, MAX_POSTERS, posterName, postersOverCap, stopPosterCaptures, usePosterStore, type PosterShot } from "./modelPosters";

/** A fake Skia: the root snapshot is 3x a 400 pt window, its sampled pixels are `fake.pixels`. */
const fake = vi.hoisted(() => ({
  pixels: new Uint8Array(0),
  crops: [] as { x: number; y: number; width: number; height: number }[],
  snapshot: { calls: 0 },
}));

vi.mock("expo-file-system", () => {
  class Directory {
    create = () => undefined;
    list = () => [];
  }
  class File {
    uri: string;
    exists = false;
    constructor(_dir: unknown, name: string) {
      this.uri = `file:///cache/model-posters/${name}`;
    }
    write = () => undefined;
  }
  return { Directory, File, Paths: { cache: "/cache" } };
});
vi.mock("@/dictation/skia", () => {
  const image = { width: () => 1200, height: () => 2400, dispose: () => undefined };
  const surface = () => ({
    getCanvas: () => ({
      drawImageRectOptions: (_img: unknown, from: { x: number; y: number; width: number; height: number }) => {
        fake.crops.push(from);
      },
    }),
    makeImageSnapshot: () => ({ readPixels: () => fake.pixels, encodeToBytes: () => new Uint8Array([1]), dispose: () => undefined }),
    dispose: () => undefined,
  });
  const skia = {
    Skia: {
      XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
      Surface: { Make: surface },
      Image: {
        MakeImageFromViewTag: () => {
          fake.snapshot.calls++;
          return Promise.resolve(image);
        },
      },
    },
    ImageFormat: { JPEG: 3 },
    ColorType: { RGBA_8888: 4 },
    AlphaType: { Unpremul: 3 },
    FilterMode: { Linear: 1 },
    MipmapMode: { None: 0 },
  };
  return { loadSkia: () => skia };
});

/** A 4x4 RGBA image from a function of the pixel index. */
const image = (pixel: (i: number) => [number, number, number, number]) => Uint8Array.from(Array.from({ length: 16 }, (_, i) => pixel(i)).flat());

const frame: Rect = { x: 20, y: 300, width: 360, height: 270 };
const shading = image((i) => [i * 12, i * 10, i * 8, 255]);
const shot = (overrides: Partial<PosterShot> = {}): PosterShot => ({
  key: "/drops/scan/token",
  rootTag: 11,
  locate: () => Promise.resolve(frame),
  clear: () => true,
  windowWidth: 400,
  ...overrides,
});

describe("capturePoster", () => {
  beforeEach(() => {
    fake.pixels = shading;
    fake.crops = [];
    fake.snapshot.calls = 0;
    usePosterStore.setState({ files: new Map(), tried: new Set() });
  });

  it("keeps the model's frame cropped out of the root snapshot as its poster", async () => {
    expect(await capturePoster(shot())).toBe("made");
    // 3 px per pt: the crop is the frame, scaled.
    expect(fake.crops[0]).toEqual({ x: 60, y: 900, width: 1080, height: 810 });
    expect(usePosterStore.getState().files.get("/drops/scan/token")).toMatch(/model-posters\/[0-9a-f]{8}-\d+\.jpg$/);
  });

  it("never snapshots a frame that is not clear of the chrome or the scroll", async () => {
    expect(await capturePoster(shot({ clear: () => false }))).toBe("later");
    expect(await capturePoster(shot({ locate: () => Promise.resolve(null) }))).toBe("later");
    expect(fake.snapshot.calls).toBe(0);
  });

  it("keeps nothing when the frame moved, resized or lost its clearance during the snapshot", async () => {
    for (const after of [{ ...frame, y: frame.y + 8 }, { ...frame, width: 200, height: 150 }]) {
      const seen = [frame, after];
      expect(await capturePoster(shot({ locate: () => Promise.resolve(seen.shift() ?? null) }))).toBe("later");
    }
    let checks = 0;
    expect(await capturePoster(shot({ clear: () => ++checks === 1 }))).toBe("later");
    expect(usePosterStore.getState().files.size).toBe(0);
    expect(usePosterStore.getState().tried.size).toBe(0);
  });

  it("drops a blank snapshot and marks the model tried, so the poster slot moves on", async () => {
    fake.pixels = image(() => [0, 0, 0, 255]);
    expect(await capturePoster(shot())).toBe("blank");
    expect(usePosterStore.getState().files.size).toBe(0);
    expect(usePosterStore.getState().tried.has("/drops/scan/token")).toBe(true);
  });

  it("never asks for a snapshot once an OTA reload began (the root view is going away)", async () => {
    // Last in this file: the stop lasts for the run, as it does in the app.
    stopPosterCaptures();
    expect(await capturePoster(shot())).toBe("later");
    expect(fake.snapshot.calls).toBe(0);
  });
});

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
