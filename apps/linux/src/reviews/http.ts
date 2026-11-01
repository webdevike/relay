// Linear's uploaded images over HTTP: `GET`/`HEAD /reviews/media/<file>/<token>`, the host-relative
// paths a ticket's markdown carries, for anyone holding the token (it only ever travels to
// authenticated devices). A file never changes under its name, so it may be cached for good.

import { serveBlob } from "../drops/serve";
import type { ReviewsRelaying } from "../seams";

export function handleReviewsMedia(reviews: ReviewsRelaying | null, request: Request, path: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const [, , , name, token, ...rest] = path.split("/");
  const blob = reviews === null || name === undefined || token === undefined || rest.length > 0 ? null : reviews.openMedia(name, token);
  if (blob === null) return new Response("not found", { status: 404 });
  const response = serveBlob(request, blob);
  response.headers.set("cache-control", "private, max-age=31536000, immutable");
  return response;
}
