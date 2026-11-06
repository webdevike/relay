// The Skills page routes, on plain `Request`/`Response` (the websocket upgrade itself stays in
// server.ts). Loopback only, JSON, used by Relay Desktop's main process and `relay-linux skills`:
//   GET  /skills                                SkillList
//   GET  /skills/<name>                         SkillDetail
//   POST /skills/<name>/access {enabled}        SkillRow (per-assistant switch, through omp profiles)
//   POST /skills/<name>/open {user?}            {token, path}: loads the live room
//   POST /skills/<name>/save {force?}           {saved, savedAt} | 409 {error: "changed-on-disk"}
//   POST /skills/<name>/reload {}               {reloaded}
//   POST /skills/<name>/edit {as, color?, find?, replace?, markdown?, save?}   {ok, dirty, saved}
//   POST /skills/<name>/leave {as}              {ok}
//   WS   /skills/<name>/ws?token=               y-websocket (server.ts), token from open
// Writes must be application/json with no Origin header (boards/http.ts explains why).

import { z } from "zod";
import { isLoopback } from "../boards/http";
import type { SkillRoom } from "./room";
import type { SkillsService } from "./service";
import { SKILL_NAME, SkillError } from "./types";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const fail = (status: number, error: string): Response => json({ error }, status);

/** The skill name in a path segment, or null when it is not one. */
function skillName(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return SKILL_NAME.test(name) ? name : null;
}

/**
 * `/skills/<name>/ws`: the room a websocket upgrade may join, or the refusal (403 off loopback, 401
 * for a token that does not open that skill). Null when `path` is not a skill's websocket route.
 */
export function authorizeSkillSocket(skills: SkillsService | null, request: Request, path: string, remote: string): SkillRoom | Response | null {
  const segment = /^\/skills\/([^/]+)\/ws$/.exec(path)?.[1];
  if (segment === undefined) return null;
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  const name = skillName(segment);
  const room = name === null ? null : (skills?.authorize(name, new URL(request.url).searchParams.get("token")) ?? null);
  return room ?? new Response("This skill link has expired. Open the skill again.", { status: 401 });
}

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb");
const AgentName = z.string().trim().min(1).max(40);
const AccessBody = z.object({ enabled: z.record(z.string(), z.boolean()) });
const OpenBody = z.object({ user: z.object({ name: z.string().max(80), color: Color }).optional() });
const SaveBody = z.object({ force: z.boolean().optional() });
const EditBody = z
  .object({
    as: AgentName,
    color: Color.optional(),
    find: z.string().min(1).max(20_000).optional(),
    replace: z.string().max(20_000).optional(),
    markdown: z.string().max(1_000_000).optional(),
    save: z.boolean().optional(),
  })
  .refine((body) => (body.find !== undefined && body.replace !== undefined) !== (body.markdown !== undefined), "give find and replace, or markdown");
const LeaveBody = z.object({ as: AgentName });

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SkillError(400, parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

/** Every `/skills` route but the websocket. */
export async function handleSkillsRequest(skills: SkillsService | null, request: Request, path: string, remote: string): Promise<Response> {
  if (!isLoopback(remote)) return fail(403, "loopback only");
  if (skills === null) return fail(404, "skills disabled");
  const method = request.method;
  if (method !== "GET") {
    // A browser page on this machine passes the loopback check but always sends Origin.
    if (request.headers.has("origin")) return fail(403, "browser requests are not allowed");
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail(415, "content-type must be application/json");
  }
  const [, , segment, verb, ...rest] = path.split("/");
  if (rest.length > 0) return fail(404, "not found");
  const body = async (): Promise<unknown> => {
    try {
      return await request.json();
    } catch {
      throw new SkillError(400, "body is not JSON");
    }
  };
  try {
    await skills.refresh();
    if (segment === undefined || segment === "") {
      if (method !== "GET") return fail(405, "method not allowed");
      return json(skills.list());
    }
    const name = skillName(segment);
    if (name === null) return fail(404, "not found");
    if (verb === undefined) {
      if (method !== "GET") return fail(405, "method not allowed");
      const detail = skills.detail(name);
      return detail === null ? fail(404, `no skill ${name}`) : json(detail);
    }
    if (method !== "POST") return fail(405, "method not allowed");
    switch (verb) {
      case "access":
        return json(await skills.setAccess(name, parseWith(AccessBody, await body()).enabled));
      case "open":
        parseWith(OpenBody, await body());
        return json(skills.open(name));
      case "save":
        return json(skills.save(name, parseWith(SaveBody, await body()).force === true));
      case "reload":
        await body();
        return json(skills.reload(name));
      case "edit":
        return json(await skills.edit(name, parseWith(EditBody, await body())));
      case "leave":
        skills.leave(name, parseWith(LeaveBody, await body()).as);
        return json({ ok: true });
      default:
        return fail(404, "not found");
    }
  } catch (error) {
    if (error instanceof SkillError) return fail(error.status, error.message);
    throw error;
  }
}
