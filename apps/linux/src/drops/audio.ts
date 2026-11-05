// Audio drops (mp3, m4a, wav, aac, flac, ogg) and the faststart rule both audio and video drops
// need. iOS AVPlayer streams a drop over HTTP ranges and, like the browsers, wants the MP4
// container's `moov` index before the media data: an ffmpeg-made mp4/m4a without
// `-movflags +faststart` has `moov` at the end and fails to load on the phone, so the host
// remuxes such a file (stream copy, no re-encode) when it stores it.

import { closeSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { extname } from "node:path";
import { findTool, probeShape, runTool } from "./video";

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
};

/** Extensions iOS AVPlayer cannot play; the share command warns about them. */
const NOT_ON_IPHONE: Readonly<Record<string, true>> = { ".ogg": true, ".oga": true, ".opus": true };

export function isAudioMime(mimeType: string): boolean {
  return mimeType.startsWith("audio/");
}

/**
 * The audio type for `name`: the extension's canonical type when it has one (clients send
 * `audio/x-m4a`, `audio/x-wav`, `audio/mp3` and the like, which AVPlayer and browsers handle
 * unevenly), else `mimeType` unchanged.
 */
export function audioMimeOf(name: string, mimeType: string): string {
  const byName = AUDIO_TYPES[extname(name).toLowerCase()];
  if (byName !== undefined && (mimeType === "" || mimeType === "application/octet-stream" || isAudioMime(mimeType) || mimeType.startsWith("video/")))
    return byName;
  return mimeType;
}

/** Whether the phone can play `name` (by extension). */
export function playsOnIphone(name: string): boolean {
  return NOT_ON_IPHONE[extname(name).toLowerCase()] !== true;
}

/** Offsets of the top-level `moov` and `mdat` boxes of the MP4-family file at `path`; null when it is not one. */
export function mp4Layout(path: string): { moov: number; mdat: number } | null {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const head = Buffer.alloc(16);
    let offset = 0;
    let moov = -1;
    let mdat = -1;
    let boxes = 0;
    while (offset + 8 <= size && boxes++ < 64) {
      if (readSync(fd, head, 0, 16, offset) < 8) break;
      let length = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (offset === 0 && type !== "ftyp") return null;
      if (length === 1) length = Number(head.readBigUInt64BE(8));
      else if (length === 0) length = size - offset;
      if (type === "moov") moov = offset;
      if (type === "mdat") mdat = offset;
      if (length < 8) return null;
      offset += length;
    }
    return moov === -1 ? null : { moov, mdat };
  } finally {
    closeSync(fd);
  }
}

/** True when `path` is an MP4-family file whose `moov` comes after its `mdat`. */
export function needsFaststart(path: string): boolean {
  const layout = mp4Layout(path);
  return layout !== null && layout.mdat !== -1 && layout.moov > layout.mdat;
}

/** Rewrites the file at `path` in place so its index comes first. Resolves false when nothing changed. */
export type Faststart = (path: string) => Promise<boolean>;

/** `Faststart` with the ffmpeg on PATH or in Homebrew's dirs: `-c copy -movflags +faststart`, then rename over the original. */
export function ffmpegFaststart(log: (line: string) => void): Faststart {
  return async (path) => {
    if (!needsFaststart(path)) return false;
    const ffmpeg = findTool("ffmpeg");
    if (ffmpeg === null) {
      log("drop: ffmpeg not found; leaving the moov atom at the end (the phone may not play it)");
      return false;
    }
    const out = `${path}.faststart`;
    try {
      await runTool([ffmpeg, "-v", "error", "-y", "-i", path, "-c", "copy", "-map", "0", "-movflags", "+faststart", "-f", "mp4", out]);
      renameSync(out, path);
      return true;
    } catch (error) {
      rmSync(out, { force: true });
      log(`drop: faststart failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
}

/** Duration in ms of the audio file at `path`; resolves undefined when it can't tell. Never rejects. */
export type AudioProbe = (path: string) => Promise<number | undefined>;

/** `AudioProbe` on the ffprobe found on PATH or in Homebrew's dirs. */
export function ffprobeDuration(log: (line: string) => void): AudioProbe {
  return async (path) => {
    const ffprobe = findTool("ffprobe");
    if (ffprobe === null) {
      log("audio drop: ffprobe not found; no duration");
      return undefined;
    }
    try {
      return (await probeShape(ffprobe, path)).durationMs;
    } catch (error) {
      log(`audio drop: ffprobe failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
}
