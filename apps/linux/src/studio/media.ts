// What Studio asks of ffmpeg: an asset's size and length, its JPEG thumb, a video's first or last
// frame, a reference image as JPEG (Codex edits take JPEG data URLs), an image cut to an exact
// size (Codex answers roughly the shape asked for), a crop, and an edit put back into its source
// inside a SAM mask. On the tools drops use
// (`findTool` adds Homebrew's dirs to launchd's bare PATH; `runTool` is Node's child_process, so
// the vitest suite can run the real thing).

import { findTool, probeShape, runTool } from "../drops/video";

/** The long side of a thumb; the gallery never shows one bigger. */
export const THUMB_MAX_PX = 640;

/** The mask's feather (Gaussian sigma) as a share of the source's short side: about 5 px at 1024. */
const FEATHER_SHARE = 0.005;

/** Outputs that get `-q:v 2` (ffmpeg's default JPEG is soft). */
const JPEG_OUT = /\.jpe?g$/i;

/** ffmpeg's argv cutting `box` (x, y, width, height as fractions of `src`) out of `src` into `dest`. */
export function cropArgv(ffmpeg: string, src: string, dest: string, box: readonly [number, number, number, number]): [string, ...string[]] {
  // Plain decimals for the expressions, never `1e-7`.
  const [x, y, w, h] = box.map((value) => Math.min(1, Math.max(0, value)).toFixed(6));
  // Width and height round to whole pixels; ffmpeg pulls x and y back in if the box would run past an edge.
  const crop = `crop=w=max(1\\,round(iw*${String(w)})):h=max(1\\,round(ih*${String(h)})):x=round(iw*${String(x)}):y=round(ih*${String(y)}):exact=1`;
  const quality = JPEG_OUT.test(dest) ? ["-q:v", "2"] : [];
  return [ffmpeg, "-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", crop, ...quality, "-update", "1", dest];
}

/**
 * ffmpeg's argv for an edit scoped to a mask: `edited` scaled to the source's `width` x `height`, laid over
 * `source` through `mask` (white = the edit) feathered by a Gaussian blur, so outside the mask the source's
 * pixels stay exactly as they were.
 */
export function compositeMaskedArgv(
  ffmpeg: string,
  files: { readonly source: string; readonly edited: string; readonly mask: string; readonly out: string },
  width: number,
  height: number,
): [string, ...string[]] {
  const size = `${String(width)}:${String(height)}`;
  const sigma = Math.max(1, Math.round(Math.min(width, height) * FEATHER_SHARE));
  const graph = [
    "[0:v]format=rgb24[source]",
    `[1:v]scale=${size}:flags=lanczos,format=rgb24[edited]`,
    `[2:v]format=gray,scale=${size}:flags=bilinear,gblur=sigma=${String(sigma)}[mask]`,
    "[edited][mask]alphamerge[inside]",
    "[source][inside]overlay=format=rgb,format=rgb24[out]",
  ].join(";");
  return [
    ffmpeg,
    "-v", "error",
    "-y",
    "-i", files.source,
    "-i", files.edited,
    "-i", files.mask,
    "-filter_complex", graph,
    "-map", "[out]",
    "-frames:v", "1",
    ...(JPEG_OUT.test(files.out) ? ["-q:v", "2"] : []),
    "-update", "1",
    files.out,
  ];
}

export interface StudioMedia {
  /** Display size, and the length of a video; `{}` when unreadable. Never rejects. */
  readonly probe: (path: string) => Promise<{ readonly width?: number; readonly height?: number; readonly durationMs?: number }>;
  /** Writes `src`'s first frame as a JPEG at most `THUMB_MAX_PX` on the long side to `dest`; false when it can't. Never rejects. */
  readonly thumb: (src: string, dest: string) => Promise<boolean>;
  /** Writes a video's first or last frame to `dest` (PNG). Rejects with a one-line reason. */
  readonly frame: (src: string, at: "first" | "last", dest: string) => Promise<void>;
  /** An image file as JPEG bytes. Rejects with a one-line reason. */
  readonly jpeg: (src: string) => Promise<Uint8Array>;
  /** Scales an image (lanczos) to cover `width` x `height`, crops the middle to exactly that, writes it to `dest` (PNG). Rejects with a one-line reason. */
  readonly cover: (src: string, dest: string, width: number, height: number) => Promise<void>;
  /** Writes `box` (x, y, width, height: fractions of `src`) of an image to `dest` (its extension picks PNG or JPEG). Rejects with a one-line reason. */
  readonly crop: (src: string, dest: string, box: readonly [number, number, number, number]) => Promise<void>;
  /**
   * Writes `source` with `edited` (scaled to the source's size) inside `mask` (a grayscale image, white = the
   * edit; its edge feathered) and the source's own pixels outside, to `out` (its extension picks PNG or JPEG).
   * Rejects with a one-line reason.
   */
  readonly compositeMasked: (source: string, edited: string, mask: string, out: string) => Promise<void>;
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
    cover: async (src, dest, width, height) => {
      const size = `${String(width)}:${String(height)}`;
      const fit = `scale=${size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size},setsar=1`;
      await runTool([ffmpeg(), "-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", fit, "-update", "1", dest]);
    },
    crop: async (src, dest, box) => {
      await runTool(cropArgv(ffmpeg(), src, dest, box));
    },
    compositeMasked: async (source, edited, mask, out) => {
      const ffprobe = findTool("ffprobe");
      if (ffprobe === null) throw new Error("ffprobe not found (brew install ffmpeg)");
      const { width, height } = await probeShape(ffprobe, source);
      if (width === undefined || height === undefined) throw new Error("Could not read the source image's size");
      await runTool(compositeMaskedArgv(ffmpeg(), { source, edited, mask, out }, width, height));
    },
  };
}
