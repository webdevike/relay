// The canvas routes, on plain `Request`/`Response` (the websocket upgrade itself stays in
// server.ts). Loopback JSON for agents on this machine (<room> is a room id or a board slug):
//   POST /canvas/sessions {slug?, title?, prompt?, caller}   start (or rejoin) a session
//   GET  /canvas/sessions                                    {rev, rooms, participants}
//   GET  /canvas/sessions/<room>                             {board, chat, participants, ...}
//   POST /canvas/sessions/<room>/end                         {summary}
//   POST /canvas/sessions/<room>/participants {name, color?, purpose?}   join as an agent
//   POST /canvas/sessions/<room>/participants/<id>/act {script}          {ran, said, skipped}
//   POST /canvas/sessions/<room>/participants/<id>/leave                 {ok}
// Token-gated, for the web client (token from `canvas.open`):
//   GET  /canvas/<slug>/?token=      the client page
//   GET  /canvas/<slug>/me?token=    {me, roomId, board, agent, live}
//   GET  /canvas/<slug>/img?token=&src=   a local image the board holds (remote URLs load directly)
//   POST /canvas/<slug>/end?token=   Wrap up -> {summary}
//   WS   /canvas/<slug>/ws?token=    y-websocket (server.ts)
// Open: GET /canvas/avatar/<key>    an assistant's avatar PNG
//       GET /canvas/portrait/<seed> a joined agent's portrait SVG

import { readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { CanvasSlug } from "@relay/protocol";
import { z } from "zod";
import { isLoopback } from "../boards/http";
import { portraitSvg } from "./portrait";
import { CanvasError, type CanvasRoom, type CanvasService, type JoinRequest, type StartRequest } from "./service";

const HUMAN_COLOR = "#0ea5e9";
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};
const EXPIRED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas</title><body style="font:15px system-ui;margin:3rem;color:#555">This canvas link has expired or the session has closed. Open it again from Relay.</body>`;

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const fail = (status: number, error: string): Response => json({ error }, status);

/**
 * `/canvas/<slug>/ws`: the room a websocket upgrade may join, or the refusal (401 for a token that
 * does not open that room). Null when `path` is not a room's websocket route.
 */
export function authorizeCanvasSocket(canvas: CanvasService | null, request: Request, path: string): CanvasRoom | Response | null {
  const slug = /^\/canvas\/([a-z0-9-]{1,80})\/ws$/.exec(path)?.[1];
  if (slug === undefined) return null;
  const access = canvas?.authorize(slug, new URL(request.url).searchParams.get("token")) ?? null;
  return access === null ? new Response("This canvas link has expired. Open it again from Relay.", { status: 401 }) : access.room;
}

const Text = z.string().max(4000);
const StartBody = z.object({
  slug: Text.optional(),
  title: Text.optional(),
  prompt: Text.optional(),
  caller: z
    .object({
      sessionFile: Text.refine(isAbsolute, "must be an absolute path").optional(),
      chatFile: Text.refine(isAbsolute, "must be an absolute path").optional(),
      assistant: Text.optional(),
      name: Text.optional(),
    })
    .refine((caller) => caller.sessionFile !== undefined || caller.assistant !== undefined, "needs sessionFile or assistant"),
});

function parseStart(body: unknown): StartRequest {
  return parseWith(StartBody, body);
}

const JoinBody = z.object({
  name: z.string().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb")
    .optional(),
  purpose: Text.optional(),
});
const ActBody = z.object({ script: z.string().min(1).max(20_000) });

function parseWith<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new CanvasError(400, parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

/** Every `/canvas` route but the websocket. `page` is the web client's HTML. */
export async function handleCanvasRequest(canvas: CanvasService | null, page: () => string, request: Request, path: string, remote: string): Promise<Response> {
  if (canvas === null) return fail(404, "live canvas disabled");
  const url = new URL(request.url);
  const parts = path.split("/").slice(2);
  try {
    if (parts[0] === "sessions") return await sessions(canvas, request, parts.slice(1), remote);
    if (parts[0] === "avatar") {
      const file = parts.length === 2 ? canvas.avatarFile(parts[1] ?? "") : null;
      if (file === null || request.method !== "GET") return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "content-type": "image/png", "cache-control": "max-age=3600" } });
    }
    if (parts[0] === "portrait") {
      const seed = parts.length === 2 ? (parts[1] ?? "") : "";
      if (!/^[a-z0-9-]{1,60}$/.test(seed) || request.method !== "GET") return new Response("not found", { status: 404 });
      return new Response(portraitSvg(seed), { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
    }
    const slug = parts[0] ?? "";
    if (!CanvasSlug.safeParse(slug).success) return new Response("not found", { status: 404 });
    const route = parts.slice(1).join("/");
    if (parts.length === 1) return Response.redirect(`${url.origin}/canvas/${slug}/${url.search}`, 301);
    const access = canvas.authorize(slug, url.searchParams.get("token"));
    if (route === "") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
      return access === null
        ? new Response(EXPIRED_PAGE, { status: 401, headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (access === null) return fail(401, "This canvas link has expired. Open it again from Relay.");
    const { room, grant } = access;
    if (route === "me" && request.method === "GET") {
      return json({ me: { name: grant.human, color: HUMAN_COLOR }, roomId: room.id, board: room.board, agent: room.agent, live: room.live });
    }
    if (route === "img" && request.method === "GET") return image(canvas, room, url.searchParams.get("src"));
    if (route === "end" && request.method === "POST") return json({ summary: await canvas.end(room.id) });
    return new Response("not found", { status: 404 });
  } catch (error) {
    if (error instanceof CanvasError) return fail(error.status, error.message);
    throw error;
  }
}

async function sessions(canvas: CanvasService, request: Request, rest: string[], remote: string): Promise<Response> {
  if (!isLoopback(remote)) return fail(403, "loopback only");
  if (request.method !== "GET") {
    // A browser page on this machine passes the loopback check but always sends Origin.
    if (request.headers.has("origin")) return fail(403, "browser requests are not allowed");
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail(415, "content-type must be application/json");
  }
  const body = async (): Promise<unknown> => {
    try {
      return await request.json();
    } catch {
      throw new CanvasError(400, "body is not JSON");
    }
  };
  const [ref = "", sub, participantId, verb] = rest;
  if (rest.length === 0) {
    if (request.method === "GET") return json({ rev: canvas.rev, rooms: canvas.list(), participants: canvas.participantsByRoom() });
    if (request.method !== "POST") return fail(405, "method not allowed");
    return json(await canvas.start(parseStart(await body())));
  }
  if (rest.length === 1) {
    if (request.method !== "GET") return fail(405, "method not allowed");
    return json(canvas.view(ref));
  }
  if (request.method !== "POST") return fail(405, "method not allowed");
  if (rest.length === 2 && sub === "end") {
    const room = canvas.roomById(ref) ?? canvas.list().find((info) => info.slug === ref && info.live);
    return json({ summary: await canvas.end(room?.id ?? ref) });
  }
  if (sub === "participants") {
    if (rest.length === 2) {
      const join: JoinRequest = parseWith(JoinBody, await body());
      return json(canvas.join(ref, join));
    }
    if (rest.length === 4 && participantId !== undefined && verb === "act") return json(await canvas.act(ref, participantId, parseWith(ActBody, await body()).script));
    if (rest.length === 4 && participantId !== undefined && verb === "leave") {
      canvas.leave(ref, participantId);
      return json({ ok: true });
    }
  }
  return fail(404, "not found");
}

/** A local image the board holds; anything else (and remote URLs, which load directly) is refused. */
function image(canvas: CanvasService, room: CanvasRoom, src: string | null): Response {
  if (src === null || src === "") return fail(400, "missing src");
  if (/^(https?:|data:|blob:)/i.test(src)) return fail(400, "remote images load directly");
  if (!room.imageSrcs().has(src)) return fail(404, "that image is not on this board");
  const file = isAbsolute(src) ? src : join(canvas.canvasDir, src);
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (type === undefined) return fail(415, "not an image");
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return fail(404, "image file missing");
  }
  return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
}
