// Studio's files over HTTP, like drops: `GET`/`HEAD /studio/<id>/<token>` is an output or upload
// (byte ranges, so a phone's player can stream and seek a video) and `/studio/<id>/<token>/thumb`
// its JPEG preview, for anyone holding the token (it only ever travels to authenticated devices).
// Paths never change, so they may be cached for good.

import { serveBlob } from "../drops/serve";
import type { StudioRelaying } from "../seams";

export function handleStudioRequest(studio: StudioRelaying | null, request: Request, path: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const [, , id, token, part, ...rest] = path.split("/");
  if (studio === null || id === undefined || token === undefined || token === "" || rest.length > 0) return new Response("not found", { status: 404 });
  const blob = part === undefined ? studio.open(id, token) : part === "thumb" ? studio.openThumb(id, token) : null;
  if (blob === null) return new Response("not found", { status: 404 });
  const response = serveBlob(request, blob);
  response.headers.set("cache-control", "private, max-age=31536000, immutable");
  return response;
}
