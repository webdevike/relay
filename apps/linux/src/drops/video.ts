// Video drops: mp4/webm/mov shared to play inline in a chat. They are capped well under
// `MAX_DROP_BYTES` (`DEFAULT_MAX_VIDEO_BYTES`, `$RELAY_MAX_VIDEO_MB` overrides) so a phone can
// stream one over the tailnet, and on share the host asks ffprobe for the duration and display size
// and ffmpeg for a poster JPEG, so a thread can show the video at its shape before fetching a byte.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, extname, join } from "node:path";

/** About a minute of 1080p H.264 at a sensible bitrate; the phone streams it over the tailnet. */
export const DEFAULT_MAX_VIDEO_BYTES = 25 * 1024 * 1024;

const VIDEO_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/** Poster frames are cut down to this width; the phone never shows one wider. */
const POSTER_MAX_WIDTH = 1280;

export function isVideoMime(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}

/** The video type for `name`'s extension when `mimeType` says nothing more specific; `mimeType` otherwise. */
export function videoMimeOf(name: string, mimeType: string): string {
  if (mimeType !== "" && mimeType !== "application/octet-stream") return mimeType;
  return VIDEO_TYPES[extname(name).toLowerCase()] ?? mimeType;
}

/** `$RELAY_MAX_VIDEO_MB` (a positive number of MiB) or the default. */
export function maxVideoBytesFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env["RELAY_MAX_VIDEO_MB"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_VIDEO_BYTES;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) throw new Error(`RELAY_MAX_VIDEO_MB must be a positive number, got ${raw}`);
  return Math.floor(mb * 1024 * 1024);
}

/** A video over the inline cap. The server answers 413 with `message`. */
export class VideoTooLarge extends Error {
  constructor(name: string, size: number, max: number) {
    super(
      `${name} is ${mib(size)} MB; inline videos are capped at ${mib(max)} MB. Shrink it to H.264 first, e.g.\n` +
        `  ${shrinkCommand(name)}\n` +
        "(raise -crf to 30-32 or lower 1280 to 960 if it is still too big; trim with -t <seconds>)",
    );
    this.name = "VideoTooLarge";
  }
}

/** The ffmpeg line the oversize error suggests: at most 1280 wide, H.264 CRF 28, AAC 96k, faststart. */
export function shrinkCommand(name: string): string {
  const stem = name.slice(0, name.length - extname(name).length) || "video";
  return `ffmpeg -i ${shellQuote(name)} -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart ${shellQuote(`${stem}-small.mp4`)}`;
}

export interface VideoMeta {
  readonly durationMs?: number;
  /** Display size: rotation already applied, so a portrait phone recording is taller than wide. */
  readonly width?: number;
  readonly height?: number;
  /** JPEG bytes of the frame at 1 s (the first frame for clips under 2 s). */
  readonly poster?: Uint8Array;
}

/** Reads `VideoMeta` for the video file at `path`; resolves `{}` when it can't tell. Never rejects. */
export type VideoProbe = (path: string) => Promise<VideoMeta>;

/** `VideoProbe` on the ffmpeg/ffprobe found on PATH or in Homebrew's dirs (launchd's PATH lacks them). */
export function ffmpegProbe(log: (line: string) => void): VideoProbe {
  return async (path) => {
    const ffprobe = findTool("ffprobe");
    const ffmpeg = findTool("ffmpeg");
    if (ffprobe === null || ffmpeg === null) {
      log("video drop: ffmpeg/ffprobe not found; no poster or metadata");
      return {};
    }
    const shape = await probeShape(ffprobe, path).catch((error: unknown): Omit<VideoMeta, "poster"> => {
      log(`video drop: ffprobe failed: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    });
    const at = shape.durationMs !== undefined && shape.durationMs >= 2000 ? 1 : 0;
    const poster = await grabPoster(ffmpeg, path, at).catch((error: unknown) => {
      log(`video drop: poster failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    return poster === undefined ? shape : { ...shape, poster };
  };
}

// Homebrew's dirs: launchd starts the Mac host with a PATH that lacks them.
const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function findTool(name: string): string | null {
  const dirs = [...(process.env["PATH"] ?? "").split(delimiter), ...EXTRA_DIRS].filter((dir) => dir !== "");
  for (const dir of dirs) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not in this dir.
    }
  }
  return null;
}

/** Node's child_process rather than Bun.spawn so the vitest suite (on Node) runs the real tools. */
function run(cmd: readonly [string, ...string[]]): Promise<Uint8Array> {
  const [file, ...args] = cmd;
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  execFile(file, args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
    if (error === null) resolve(new Uint8Array(stdout));
    else reject(new Error(`${file}: ${error.message.split("\n")[0] ?? ""} ${stderr.toString().trim().slice(0, 300)}`));
  });
  return promise;
}

interface ProbeJson {
  streams?: {
    width?: number;
    height?: number;
    tags?: { rotate?: string };
    side_data_list?: { rotation?: number }[];
  }[];
  format?: { duration?: string };
}

/** Duration and display size; exported for tests that run the real ffprobe. */
export async function probeShape(ffprobe: string, path: string): Promise<Omit<VideoMeta, "poster">> {
  const out = await run([
    ffprobe,
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration",
    "-of", "json",
    path,
  ]);
  const json = JSON.parse(new TextDecoder().decode(out)) as ProbeJson;
  const stream = json.streams?.[0];
  const seconds = Number(json.format?.duration);
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  const w = stream?.width;
  const h = stream?.height;
  if (w === undefined || h === undefined || w <= 0 || h <= 0) return durationMs === undefined ? {} : { durationMs };
  const rotation = Number(stream?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? stream?.tags?.rotate ?? 0);
  const sideways = Math.abs(rotation) % 180 === 90;
  const size = sideways ? { width: h, height: w } : { width: w, height: h };
  return durationMs === undefined ? size : { durationMs, ...size };
}

async function grabPoster(ffmpeg: string, path: string, atSeconds: number): Promise<Uint8Array | undefined> {
  const jpeg = await run([
    ffmpeg,
    "-v", "error",
    "-ss", String(atSeconds),
    "-i", path,
    "-frames:v", "1",
    "-vf", `scale='min(${String(POSTER_MAX_WIDTH)},iw)':-2`,
    "-q:v", "4",
    "-f", "image2pipe",
    "-c:v", "mjpeg",
    "pipe:1",
  ]);
  return jpeg.length > 0 ? jpeg : undefined;
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "");
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
