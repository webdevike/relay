// What Studio asks of ffmpeg: an asset's size and length, its JPEG thumb, a video's first or last
// frame, and a reference image as JPEG (Codex edits take JPEG data URLs). On the tools drops use
// (`findTool` adds Homebrew's dirs to launchd's bare PATH; `runTool` is Node's child_process, so
// the vitest suite can run the real thing).

import { findTool, probeShape, runTool } from "../drops/video";

/** The long side of a thumb; the gallery never shows one bigger. */
export const THUMB_MAX_PX = 640;

export interface StudioMedia {
  /** Display size, and the length of a video; `{}` when unreadable. Never rejects. */
  readonly probe: (path: string) => Promise<{ readonly width?: number; readonly height?: number; readonly durationMs?: number }>;
  /** Writes `src`'s first frame as a JPEG at most `THUMB_MAX_PX` on the long side to `dest`; false when it can't. Never rejects. */
  readonly thumb: (src: string, dest: string) => Promise<boolean>;
  /** Writes a video's first or last frame to `dest` (PNG). Rejects with a one-line reason. */
  readonly frame: (src: string, at: "first" | "last", dest: string) => Promise<void>;
  /** An image file as JPEG bytes. Rejects with a one-line reason. */
  readonly jpeg: (src: string) => Promise<Uint8Array>;
}

export function ffmpegMedia(log: (line: string) => void): StudioMedia {
  const ffmpeg = (): string => {
    const path = findTool("ffmpeg");
    if (path === null) throw new Error("ffmpeg not found (brew install ffmpeg)");
    return path;
  };
  return {
    probe: async (path) => {
      const ffprobe = findTool("ffprobe");
      if (ffprobe === null) {
        log("studio: ffprobe not found; no asset sizes");
        return {};
      }
      return probeShape(ffprobe, path).catch((error: unknown) => {
        log(`studio: ffprobe failed: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      });
    },
    thumb: async (src, dest) => {
      try {
        const box = String(THUMB_MAX_PX);
        await runTool([
          ffmpeg(),
          "-v", "error",
          "-y",
          "-i", src,
          "-frames:v", "1",
          "-vf", `scale='min(${box},iw)':'min(${box},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
          "-q:v", "4",
          dest,
        ]);
        return true;
      } catch (error) {
        log(`studio: thumb failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    frame: async (src, at, dest) => {
      // `-update 1` keeps overwriting one image, so after seeking near the end the last decoded frame stays.
      const seek = at === "last" ? ["-sseof", "-1"] : [];
      await runTool([ffmpeg(), "-v", "error", "-y", ...seek, "-i", src, "-update", "1", dest]);
    },
    jpeg: async (src) => await runTool([ffmpeg(), "-v", "error", "-i", src, "-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"]),
  };
}
