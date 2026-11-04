// Loopback-only routes for the host's jobs and the assistants' own sessions (`relay-linux assistant ...`):
//   - `POST /assistant/say?agent=<id>` (text/plain, like `POST /drops`) hands an assistant thread a
//     message to relay to Isaac. A missing or unknown `agent` is a 400: job lines never fall back to a default.
//   - `GET /assistant/registry` lists the registry's entries; `POST` adds one (JSON draft, plus
//     `start` to start its thread); `PATCH /assistant/registry/<id>` changes one and answers what
//     changed; `DELETE /assistant/registry/<id>` retires one.
//   - `POST /assistant/avatars?agent=<id>&page=<n>` and `POST /assistant/voices?agent=<id>` answer
//     the setup interview's look and voice widgets as OpenUI programs (text/plain).

import { isLoopback } from "../boards/http";
import { AckFailure, type AssistantRelaying } from "../seams";
import type { AssistantRegistry } from "./admin";
import { RegistryError } from "./registry";
import type { InterviewSamples } from "./samples";

/** Answers `POST /assistant/say`; `assistant` null (no threads on this host) is a 404. */
export async function handleAssistantSay(assistant: AssistantRelaying | null, request: Request, remote: string): Promise<Response> {
  if (assistant === null) return new Response("assistant disabled", { status: 404 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  const agent = new URL(request.url).searchParams.get("agent");
  if (agent === null || agent === "") return new Response("missing agent", { status: 400 });
  const thread = assistant.thread(agent);
  if (thread === undefined) return new Response(`unknown agent ${agent}`, { status: 400 });
  const text = (await request.text()).trim();
  if (text === "") return new Response("empty text", { status: 400 });
  try {
    await thread.say(text);
    return new Response("ok");
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 503 });
  }
}

/** What the registry routes run on; null fields answer 404 (no agent home, no threads). */
export interface AssistantAdmin {
  readonly registry: AssistantRegistry | null;
  readonly samples: InterviewSamples | null;
  readonly assistant: AssistantRelaying | null;
}

/** Whether `path` is one of the routes `handleAssistantAdmin` answers. */
export function isAssistantAdminPath(path: string): boolean {
  return path === "/assistant/registry" || path.startsWith("/assistant/registry/") || path === "/assistant/avatars" || path === "/assistant/voices";
}

/** Answers the registry and interview routes; a `RegistryError` or `AckFailure` is a 400 with its message. */
export async function handleAssistantAdmin(admin: AssistantAdmin, request: Request, remote: string, path: string): Promise<Response> {
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  const registry = admin.registry;
  if (registry === null) return new Response("assistant registry disabled (no agent home)", { status: 404 });
  const query = new URL(request.url).searchParams;
  try {
    if (path === "/assistant/registry") {
      if (request.method === "GET") return Response.json({ agents: registry.list() });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const assistant = admin.assistant;
      if (assistant?.create === undefined) return new Response("assistant threads disabled", { status: 404 });
      const { start, ...draft } = (await request.json()) as Record<string, unknown>;
      const added = await assistant.create(draft as { title: string }, start === true);
      return Response.json(registry.list().find((entry) => entry.id === added.id) ?? added, { status: 201 });
    }
    if (path.startsWith("/assistant/registry/")) {
      const id = decodeURIComponent(path.slice("/assistant/registry/".length));
      if (request.method === "PATCH") return Response.json({ changes: registry.update(id, await request.json()) });
      if (request.method === "DELETE") return Response.json(registry.retire(id));
      return new Response("method not allowed", { status: 405 });
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const agent = query.get("agent") ?? "";
    const entry = registry.list().find((candidate) => candidate.id === agent);
    if (entry === undefined) return new Response(`unknown agent ${agent}`, { status: 400 });
    const samples = admin.samples;
    if (samples === null) return new Response("interview samples disabled (no drop box)", { status: 404 });
    if (path === "/assistant/avatars") {
      const page = Number.parseInt(query.get("page") ?? "1", 10);
      if (!Number.isInteger(page) || page < 1) return new Response("page must be 1 or more", { status: 400 });
      return new Response(await samples.avatars(entry.title, registry.offerAvatars(agent, page)));
    }
    const program = await samples.voices(entry.title);
    return program === null ? new Response("no voices on this host (no OpenAI key and no pocket-tts)", { status: 404 }) : new Response(program);
  } catch (error) {
    if (error instanceof RegistryError) return new Response(error.message, { status: 400 });
    if (error instanceof AckFailure) return new Response(error.error.message, { status: 400 });
    if (error instanceof SyntaxError) return new Response(`body is not JSON: ${error.message}`, { status: 400 });
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }
}
