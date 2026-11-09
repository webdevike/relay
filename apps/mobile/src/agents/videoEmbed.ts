/**
 * Which markdown images (`![caption](src)`) are videos or audio. Agents embed a shared video or
 * sound exactly like a picture, so the src decides: a host drop path (bare, or as a full https URL
 * through Tailscale Serve) whose drop (from the drops list the phone asks for on every connect) has
 * a `video/*` (or, for `audioEmbedOf`, `audio/*`) type, or an http(s) URL whose path ends in a
 * video (audio) extension. `modelEmbedOf` finds 3D models the same way, which markdown can't show.
 * Everything else stays a picture.
 */
import type { Drop } from "@relay/protocol";
import { imageSrcKind } from "./markdown";

export interface VideoEmbed {
  src: string;
  /** Host drop path of the poster JPEG, when the host cut one. */
  poster?: string;
  /** Width over height, from the drop, so the frame has its shape before anything loads. */
  aspect?: number;
  durationMs?: number;
  mimeType?: string;
}

const VIDEO_PATH = /\.(mp4|m4v|mov|webm)$/i;

export function videoEmbedOf(src: string, drops: readonly Drop[]): VideoEmbed | null {
  switch (imageSrcKind(src)) {
    case "remote": {
      let url: URL;
      try {
        url = new URL(src);
      } catch {
        return null;
      }
      if (imageSrcKind(url.pathname) === "drop") {
        const embed = dropVideo(url.pathname, drops);
        if (embed !== null) {
          const { poster, ...rest } = embed;
          return { ...rest, src, ...(poster !== undefined && { poster: `${url.origin}${poster}` }) };
        }
      }
      return VIDEO_PATH.test(url.pathname) ? { src } : null;
    }
    case "drop":
      return dropVideo(src, drops);
    case "local":
      return null;
  }
}

function dropVideo(path: string, drops: readonly Drop[]): VideoEmbed | null {
  const file = drops.find((drop) => drop.file?.path === path)?.file;
  if (!file?.mimeType.startsWith("video/")) return null;
  const { poster, width, height, durationMs, mimeType } = file;
  return {
    src: path,
    mimeType,
    ...(poster !== undefined && { poster }),
    ...(width !== undefined && height !== undefined && { aspect: width / height }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

export interface AudioEmbed {
  src: string;
  durationMs?: number;
}

const AUDIO_PATH = /\.(mp3|m4a|aac|wav|flac)$/i;

export function audioEmbedOf(src: string, drops: readonly Drop[]): AudioEmbed | null {
  let path = src;
  if (imageSrcKind(src) === "remote") {
    try {
      const url = new URL(src);
      if (imageSrcKind(url.pathname) !== "drop") return AUDIO_PATH.test(url.pathname) ? { src } : null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else if (imageSrcKind(src) !== "drop") {
    return null;
  }
  const file = drops.find((drop) => drop.file?.path === path)?.file;
  if (!file?.mimeType.startsWith("audio/")) return null;
  return { src, ...(file.durationMs !== undefined && { durationMs: file.durationMs }) };
}

export interface ModelEmbed {
  src: string;
  /** The type the host serves the drop as, or the one its extension stands for. */
  mimeType: string;
}

const MODEL_PATH = /\.(glb|gltf)$/i;

/**
 * A 3D model embedded as a markdown image: a drop with a `model/*` type (or a `.glb`/`.gltf` name,
 * since the host may serve it as octet-stream), or an http(s) URL ending in one. Markdown never
 * draws it (only an openui Model block does, one live model at a time), so `MarkdownImages` shows
 * a notice instead of an image tile that can only fail.
 */
export function modelEmbedOf(src: string, drops: readonly Drop[]): ModelEmbed | null {
  let path = src;
  if (imageSrcKind(src) === "remote") {
    try {
      const url = new URL(src);
      if (imageSrcKind(url.pathname) !== "drop") {
        if (!MODEL_PATH.test(url.pathname)) return null;
        return { src, mimeType: url.pathname.toLowerCase().endsWith(".gltf") ? "model/gltf+json" : "model/gltf-binary" };
      }
      path = url.pathname;
    } catch {
      return null;
    }
  } else if (imageSrcKind(src) !== "drop") {
    return null;
  }
  const file = drops.find((drop) => drop.file?.path === path)?.file;
  return file !== undefined && (file.mimeType.startsWith("model/") || MODEL_PATH.test(file.name)) ? { src, mimeType: file.mimeType } : null;
}
