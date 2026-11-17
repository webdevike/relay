// `POST /meetings/context` (loopback, bearer token, JSON `{ agent }`): the relay bridge in an
// assistant's thread asks it before each turn; answers `{ id, text }` for the meeting in that chat
// (MeetingsService.contextFor, which counts it as given) or `{}` when there is nothing new.
//
// `GET`/`HEAD /meetings/shots/<id>/<token>/<n>`: a screen snapshot of a call, like Studio's
// `/studio/<id>/<token>`, for anyone holding the recording's token (it only ever travels to
// authenticated devices). A snapshot never changes, so it may be cached for good.

import { z } from "zod";
import { isLoopback } from "../boards/http";
import { serveBlob } from "../drops/serve";
import type { MeetingsRelaying } from "../seams";

export const MEETINGS_CONTEXT_PATH = "/meetings/context";
export const MEETINGS_SHOTS_PREFIX = "/meetings/shots/";

export function handleMeetingShot(
  meetings: MeetingsRelaying | null,
  request: Request,
  path: string,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", { status: 405 });
  const [, , , id, token, n, ...rest] = path.split("/");
  const blob =
    meetings === null ||
    id === undefined ||
    token === undefined ||
    token === "" ||
    n === undefined ||
    !/^\d{1,6}$/.test(n) ||
    rest.length > 0
      ? null
      : meetings.openShot(id, token, Number(n));
  if (blob === null) return new Response("not found", { status: 404 });
  const response = serveBlob(request, blob);
  response.headers.set("cache-control", "private, max-age=31536000, immutable");
  return response;
}

const Body = z.object({ agent: z.string().min(1).max(64) });

export async function handleMeetingsContext(
  meetings: MeetingsRelaying | null,
  request: Request,
  remote: string,
): Promise<Response> {
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return new Response("body must be JSON { agent }", { status: 400 });
  }
  return Response.json(meetings?.contextFor(body.agent) ?? {});
}
