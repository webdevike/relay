import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { audioMimeOf, ffmpegFaststart, ffprobeDuration, isAudioMime, needsFaststart, playsOnIphone } from "../src/drops/audio";
import { FileDropStore } from "../src/drops/store";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-audio-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("audio types", () => {
  it("normalizes by extension and recognizes audio", () => {
    expect(audioMimeOf("a.m4a", "audio/x-m4a")).toBe("audio/mp4");
    expect(audioMimeOf("a.mp3", "application/octet-stream")).toBe("audio/mpeg");
    expect(audioMimeOf("a.WAV", "audio/x-wav")).toBe("audio/wav");
    expect(audioMimeOf("a.m4a", "video/mp4")).toBe("audio/mp4");
    expect(audioMimeOf("a.png", "image/png")).toBe("image/png");
    expect(audioMimeOf("a.zip", "application/zip")).toBe("application/zip");
    expect(isAudioMime("audio/aac")).toBe(true);
    expect(isAudioMime("video/mp4")).toBe(false);
    expect(playsOnIphone("a.ogg")).toBe(false);
    expect(playsOnIphone("a.m4a")).toBe(true);
  });
});

const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find((path) => existsSync(path)) ?? null;

describe.skipIf(ffmpeg === null)("audio drops with real ffmpeg", () => {
  function tone(dir: string, name: string, extra: string[] = []): string {
    const path = join(dir, name);
    const made = spawnSync(ffmpeg ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", ...extra, path]);
    expect(made.status).toBe(0);
    return path;
  }

  it("moves an m4a's moov to the front and records the duration and final size", async () => {
    const dir = freshDir();
    const source = tone(dir, "tone.m4a", ["-c:a", "aac"]);
    expect(needsFaststart(source)).toBe(true);
    const store = new FileDropStore(join(dir, "drops"), { faststart: ffmpegFaststart(() => undefined), probeAudio: ffprobeDuration(() => undefined) });
    const drop = await store.putAudio("host", { name: "tone.m4a", mimeType: "audio/mp4", bytes: new Uint8Array(readFileSync(source)) });
    const token = drop.file?.path.split("/")[3] ?? "";
    const blob = store.open(drop.id, token);
    expect(blob).not.toBeNull();
    expect(needsFaststart(blob?.path ?? "")).toBe(false);
    expect(blob?.size).toBe(readFileSync(blob?.path ?? "").length);
    expect(drop.file?.durationMs).toBeGreaterThan(1900);
    expect(drop.file?.durationMs).toBeLessThan(2200);
    expect(drop.file?.mimeType).toBe("audio/mp4");
  });

  it("stores an mp3 untouched with its duration", async () => {
    const dir = freshDir();
    const source = tone(dir, "tone.mp3", ["-c:a", "libmp3lame"]);
    const store = new FileDropStore(join(dir, "drops"), { faststart: ffmpegFaststart(() => undefined), probeAudio: ffprobeDuration(() => undefined) });
    const bytes = new Uint8Array(readFileSync(source));
    const drop = await store.putAudio("host", { name: "tone.mp3", mimeType: "audio/mpeg", bytes });
    expect(drop.file?.size).toBe(bytes.length);
    expect(drop.file?.durationMs).toBeGreaterThan(1900);
  });
});
