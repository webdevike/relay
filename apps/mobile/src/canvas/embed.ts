/**
 * The phone's side of the host web client's embed contract (`packages/canvas-live/src/shared.ts`
 * `EmbedEvent`, hand-ported: the app does not depend on canvas-live). The page is loaded with
 * `embed=phone` and the app's color scheme, and posts `canvas.ready` / `canvas.ended` through
 * `window.ReactNativeWebView.postMessage`.
 */
import type { ColorScheme } from "@/theme";

export type EmbedEvent = { type: "canvas.ready"; slug: string } | { type: "canvas.ended"; slug: string; summary: string | null };

/** `url` (the access URL, token already in its query) with the embed mode and theme added. */
export function canvasEmbedUrl(url: string, scheme: ColorScheme): string {
  return `${url}${url.includes("?") ? "&" : "?"}embed=phone&theme=${scheme}`;
}

/** `scheme://authority` of an absolute URL, lowercased; null when `url` is not absolute. */
function originOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(url);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether a navigation stays in the room: the host's own origin (the page, its websocket, its
 * images) or `about:`. Anything else is a link on the board, opened outside the app. Written
 * without `URL`, whose getters React Native does not fully implement.
 */
export function staysInRoom(target: string, roomUrl: string): boolean {
  if (target.startsWith("about:")) return true;
  const origin = originOf(target);
  return origin !== null && origin === originOf(roomUrl);
}

/** A page message as an `EmbedEvent`, or null for anything else the page may post. */
export function parseEmbedEvent(data: string): EmbedEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { type, slug, summary } = value as Record<string, unknown>;
  if (typeof slug !== "string") return null;
  if (type === "canvas.ready") return { type, slug };
  if (type === "canvas.ended") return { type, slug, summary: typeof summary === "string" && summary !== "" ? summary : null };
  return null;
}
