/**
 * Which markdown images (`![caption](src)`) are videos. Agents embed a shared video exactly like a
 * picture, so the src decides: a host drop path (bare, or as a full https URL through Tailscale
 * Serve) whose drop (from the drops list the phone asks for on every connect) has a `video/*`
 * type, or an http(s) URL whose path ends in a video extension. Everything else stays a picture.
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
