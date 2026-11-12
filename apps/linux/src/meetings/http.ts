// `POST /meetings/context` (loopback, bearer token, JSON `{ agent }`): the relay bridge in an
// assistant's thread asks it before each turn; answers `{ id, text }` for the meeting in that chat
// (MeetingsService.contextFor, which counts it as given) or `{}` when there is nothing new.

import { z } from "zod";
import { isLoopback } from "../boards/http";
import type { MeetingsRelaying } from "../seams";

export const MEETINGS_CONTEXT_PATH = "/meetings/context";

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
