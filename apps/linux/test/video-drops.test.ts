import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { byteRange, serveBlob } from "../src/drops/serve";
import { FileDropStore } from "../src/drops/store";
import {
  DEFAULT_MAX_VIDEO_BYTES,
  ffmpegProbe,
  maxVideoBytesFromEnv,
  shrinkCommand,
  videoMimeOf,
  VideoTooLarge,
  type VideoProbe,
} from "../src/drops/video";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-video-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const fakeProbe: VideoProbe = () => Promise.resolve({ durationMs: 10_000, width: 1280, height: 720, poster: JPEG });
const tokenOf = (path: string | undefined): string => path?.split("/")[3] ?? "";

describe("video drops", () => {
  it("stores duration, display size and a poster served under the same token", async () => {
    const store = new FileDropStore(freshDir(), { probe: fakeProbe });
    const drop = await store.putVideo("host", { name: "demo.mp4", mimeType: "video/mp4", bytes: new Uint8Array(64) });
    const token = tokenOf(drop.file?.path);
    expect(drop.kind).toBe("file");
    expect(drop.file).toMatchObject({
      mimeType: "video/mp4",
      size: 64,
      durationMs: 10_000,
      width: 1280,
      height: 720,
      poster: `/drops/${drop.id}/${token}/poster`,
    });
    expect(store.openPoster(drop.id, token)).toMatchObject({ mimeType: "image/jpeg", size: JPEG.length });
    expect(store.openPoster(drop.id, "0".repeat(64))).toBeNull();
    const posterPath = store.openPoster(drop.id, token)?.path ?? "";
    expect(store.remove(drop.id)).toBe(true);
    expect(existsSync(posterPath)).toBe(false);
  });

  it("keeps a video without a poster when the probe can't read it", async () => {
    const store = new FileDropStore(freshDir(), { probe: () => Promise.resolve({}) });
    const drop = await store.putVideo("host", { name: "x.webm", mimeType: "video/webm", bytes: new Uint8Array(8) });
    expect(drop.file?.poster).toBeUndefined();
    expect(drop.file?.durationMs).toBeUndefined();
    expect(store.openPoster(drop.id, tokenOf(drop.file?.path))).toBeNull();
    expect(store.open(drop.id, tokenOf(drop.file?.path))).toMatchObject({ mimeType: "video/webm" });
  });

  it("refuses a video over the cap with the size and an ffmpeg line to shrink it", async () => {
    const store = new FileDropStore(freshDir(), { maxVideoBytes: 1024, probe: fakeProbe });
    const big = { name: "screen recording.mov", mimeType: "video/quicktime", bytes: new Uint8Array(4096) };
    await expect(store.putVideo("host", big)).rejects.toBeInstanceOf(VideoTooLarge);
    expect(() => store.putBlob("host", big)).toThrow(VideoTooLarge);
    await expect(store.putVideo("host", big)).rejects.toThrow(/screen recording\.mov is 0 MB; inline videos are capped at 0 MB/);
    // Other files keep the general blob limit.
    expect(store.putBlob("host", { name: "big.zip", mimeType: "application/zip", bytes: new Uint8Array(4096) }).kind).toBe("file");
    expect(store.list()).toHaveLength(1);
  });

  it("suggests an H.264 shrink that keeps the name and quotes it for the shell", () => {
    expect(shrinkCommand("screen recording.mov")).toBe(
      `ffmpeg -i 'screen recording.mov' -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart 'screen recording-small.mp4'`,
    );
  });

  it("types videos by extension when the client sent none, and reads the cap from the env", () => {
    expect(videoMimeOf("a.MP4", "application/octet-stream")).toBe("video/mp4");
    expect(videoMimeOf("a.mov", "")).toBe("video/quicktime");
    expect(videoMimeOf("a.webm", "application/octet-stream")).toBe("video/webm");
    expect(videoMimeOf("a.mp4", "video/x-custom")).toBe("video/x-custom");
    expect(videoMimeOf("a.bin", "application/octet-stream")).toBe("application/octet-stream");
    expect(maxVideoBytesFromEnv({})).toBe(DEFAULT_MAX_VIDEO_BYTES);
    expect(DEFAULT_MAX_VIDEO_BYTES).toBe(25 * 1024 * 1024);
    expect(maxVideoBytesFromEnv({ RELAY_MAX_VIDEO_MB: "40" })).toBe(40 * 1024 * 1024);
    expect(() => maxVideoBytesFromEnv({ RELAY_MAX_VIDEO_MB: "lots" })).toThrow(/RELAY_MAX_VIDEO_MB/);
  });
});

describe("byteRange", () => {
  it("reads single ranges, clamps the end and answers unsatisfiable past the end", () => {
    expect(byteRange(null, 100)).toBeNull();
    expect(byteRange("bytes=0-1", 100)).toEqual([0, 1]);
    expect(byteRange("bytes=50-", 100)).toEqual([50, 99]);
    expect(byteRange("bytes=90-500", 100)).toEqual([90, 99]);
    expect(byteRange("bytes=-10", 100)).toEqual([90, 99]);
    expect(byteRange("bytes=-500", 100)).toEqual([0, 99]);
    expect(byteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=5-1", 100)).toBeNull();
    expect(byteRange("bytes=0-1,5-9", 100)).toBeNull();
    expect(byteRange("items=0-1", 100)).toBeNull();
  });
});

describe("serveBlob", () => {
  const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
  function blob(mimeType: string) {
    const path = join(freshDir(), "blob");
    writeFileSync(path, bytes);
    return { path, name: "demo clip.mp4", mimeType, size: bytes.length };
  }
  const get = (headers: Record<string, string> = {}, method = "GET") =>
    new Request("http://host/drops/a/b", { method, headers });

  it("serves the whole video inline with its type and advertises ranges", async () => {
    const response = serveBlob(get(), blob("video/mp4"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("content-disposition")).toBe(`inline; filename="demo%20clip.mp4"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("answers AVPlayer's 0-1 probe and a seek with 206 and the exact bytes", async () => {
    const probe = serveBlob(get({ range: "bytes=0-1" }), blob("video/mp4"));
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe("bytes 0-1/100");
    expect(probe.headers.get("content-length")).toBe("2");
    expect([...new Uint8Array(await probe.arrayBuffer())]).toEqual([0, 1]);
    const seek = serveBlob(get({ range: "bytes=60-" }), blob("video/mp4"));
    expect(seek.headers.get("content-range")).toBe("bytes 60-99/100");
    expect([...new Uint8Array(await seek.arrayBuffer())]).toEqual(Array.from({ length: 40 }, (_, i) => 60 + i));
  });

  it("answers HEAD without a body, 416 past the end, and keeps other files as attachments", () => {
    const head = serveBlob(get({}, "HEAD"), blob("video/webm"));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("100");
    expect(head.body).toBeNull();
    const past = serveBlob(get({ range: "bytes=100-" }), blob("video/mp4"));
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */100");
    expect(serveBlob(get(), blob("application/zip")).headers.get("content-disposition")).toMatch(/^attachment;/);
  });
});

const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find((path) => existsSync(path)) ?? null;

describe.skipIf(ffmpeg === null)("ffmpegProbe", () => {
  it("reads a real clip's duration and size and cuts a JPEG poster", async () => {
    const path = join(freshDir(), "clip.mp4");
    const made = spawnSync(ffmpeg ?? "ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
      "-t", "3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      path,
    ]);
    expect(made.status).toBe(0);
    const logs: string[] = [];
    const meta = await ffmpegProbe((line) => logs.push(line))(path);
    expect(logs).toEqual([]);
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
    expect(meta.durationMs).toBeGreaterThan(2900);
    expect(meta.durationMs).toBeLessThan(3100);
    expect([...(meta.poster ?? new Uint8Array()).slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("resolves empty for a file that isn't a video", async () => {
    const path = join(freshDir(), "not.mp4");
    writeFileSync(path, "hello");
    const logs: string[] = [];
    expect(await ffmpegProbe((line) => logs.push(line))(path)).toEqual({});
    expect(logs.length).toBeGreaterThan(0);
  });
});
