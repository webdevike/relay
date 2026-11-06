// Loopback-only routes for the host's jobs and the assistants' own sessions (`relay-linux assistant ...`):
//   - `POST /assistant/say?agent=<id>` (text/plain, like `POST /drops`) hands an assistant thread a
//     message to relay to Isaac. A missing or unknown `agent` is a 400: job lines never fall back to a default.
//   - `GET /assistant/registry` lists the registry's entries; `POST` adds one (JSON draft, plus
//     `start` to start its thread); `PATCH /assistant/registry/<id>` changes one and answers what
//     changed; `DELETE /assistant/registry/<id>` retires one.
//   - `GET /assistant/asks[?agent=<id>]` lists the open asks (every thread's without `agent`);
//     `POST /assistant/asks` (JSON `{ thread, from, session?, question, options, default? }`) puts
//     another omp session's question to Isaac through thread `thread` and answers `{ id }`;
//     `POST /assistant/asks/resolve` (JSON `{ id, agent?, answer? }`) closes one, as answered with
//     `answer` (a session's ask then gets it delivered) or else as resolved by the assistant;
//     `GET /assistant/asks/<id>` reads one, open or closed, from whichever thread has it
//     (`relay-linux asks list|add|resolve|get`). An id that is not open (or, for get, not kept) is a 404.

import { MAX_ASK_ANSWER, type OpenAsk } from "@relay/protocol";
import { z } from "zod";
import { isLoopback } from "../boards/http";
import { AckFailure, type AskStatus, type AssistantRelaying, type AssistantThread } from "../seams";
import type { AssistantRegistry } from "./admin";
import { RegistryError } from "./registry";

/** An open ask as the asks routes list it: with the thread it belongs to. */
export type ListedAsk = OpenAsk & { readonly agent: string };
/** An ask as `GET /assistant/asks/<id>` reads it: with the thread it belongs to. */
export type FoundAsk = AskStatus & { readonly agent: string };

/** What `POST /assistant/asks/resolve` takes. */
const ResolveBody = z.object({ id: z.string().min(1), agent: z.string().min(1).optional(), answer: z.string().trim().min(1).max(MAX_ASK_ANSWER).optional() });
/** What `POST /assistant/asks` takes; the thread checks the fields themselves (`AssistantThread.addAsk`). */
const AddBody = z.object({
  thread: z.string().min(1),
  from: z.string(),
  session: z.string().optional(),
  question: z.string(),
  options: z.array(z.string()),
  default: z.string().optional(),
});

/** Whether `path` is one of the routes `handleAssistantAsks` answers. */
export function isAssistantAsksPath(path: string): boolean {
  return path === "/assistant/asks" || path.startsWith("/assistant/asks/");
}

/** The request's JSON body, or a 400 for one that is not JSON. */
async function jsonBody(request: Request): Promise<{ body: unknown } | Response> {
  try {
    return { body: await request.json() };
  } catch (error) {
    return new Response(`body is not JSON: ${error instanceof Error ? error.message : String(error)}`, { status: 400 });
  }
}

/** Answers the `/assistant/asks` routes; `assistant` null (no threads on this host) is a 404. */
export async function handleAssistantAsks(assistant: AssistantRelaying | null, request: Request, remote: string, path: string): Promise<Response> {
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  if (assistant === null) return new Response("assistant disabled", { status: 404 });
  try {
    if (path === "/assistant/asks" && request.method === "GET") {
      const query = new URL(request.url).searchParams.get("agent");
      const agent = query === "" ? null : query;
      let threads: readonly AssistantThread[] = assistant.threads;
      if (agent !== null) {
        const thread = assistant.thread(agent);
        if (thread === undefined) return new Response(`unknown agent ${agent}`, { status: 400 });
        threads = [thread];
      }
      const listed: ListedAsk[] = [];
      for (const thread of threads) for (const ask of (await thread.snapshot()).asks ?? []) listed.push({ agent: thread.id, ...ask });
      return Response.json({ asks: listed });
    }
    if (path === "/assistant/asks" && request.method === "POST") {
      const read = await jsonBody(request);
      if (read instanceof Response) return read;
      const fields = AddBody.safeParse(read.body);
      if (!fields.success) return new Response("expected {thread, from, session?, question, options, default?}", { status: 400 });
      const { thread: agent, session, default: fallback, ...input } = fields.data;
      const thread = assistant.thread(agent);
      if (thread === undefined) return new Response(`unknown agent ${agent}`, { status: 400 });
      const id = thread.addAsk({ ...input, ...(session === undefined ? {} : { session }), ...(fallback === undefined ? {} : { default: fallback }) });
      return Response.json({ id }, { status: 201 });
    }
    if (path === "/assistant/asks/resolve") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const read = await jsonBody(request);
      if (read instanceof Response) return read;
      const fields = ResolveBody.safeParse(read.body);
      if (!fields.success) return new Response(`expected {id, agent?, answer?} (answer at most ${String(MAX_ASK_ANSWER)} characters)`, { status: 400 });
      const { id, agent, answer } = fields.data;
      const thread = agent === undefined ? undefined : assistant.thread(agent);
      if (agent !== undefined && thread === undefined) return new Response(`unknown agent ${agent}`, { status: 400 });
      const owner = (thread === undefined ? assistant.threads : [thread]).find((candidate) => candidate.findAsk(id)?.state === "open");
      if (owner?.resolveAsk(id, answer === undefined ? "resolved" : "answered", answer) !== true) {
        return new Response(`no open ask ${id}${agent === undefined ? "" : ` on ${agent}`}`, { status: 404 });
      }
      const closed = owner.findAsk(id);
      return closed === undefined ? new Response(`no ask ${id}`, { status: 404 }) : Response.json({ agent: owner.id, ...closed } satisfies FoundAsk);
    }
    if (path === "/assistant/asks" || request.method !== "GET") return new Response("method not allowed", { status: 405 });
    const id = decodeURIComponent(path.slice("/assistant/asks/".length));
    for (const thread of assistant.threads) {
      const found = thread.findAsk(id);
      if (found !== undefined) return Response.json({ agent: thread.id, ...found } satisfies FoundAsk);
    }
    return new Response(`no ask ${id}`, { status: 404 });
  } catch (error) {
    if (error instanceof AckFailure) return new Response(error.error.message, { status: error.error.code === "agent_not_found" ? 404 : 400 });
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }
}

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
  readonly assistant: AssistantRelaying | null;
}

/** Whether `path` is one of the routes `handleAssistantAdmin` answers. */
export function isAssistantAdminPath(path: string): boolean {
  return path === "/assistant/registry" || path.startsWith("/assistant/registry/");
}

/** Answers the registry routes; a `RegistryError` or `AckFailure` is a 400 with its message. */
export async function handleAssistantAdmin(admin: AssistantAdmin, request: Request, remote: string, path: string): Promise<Response> {
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  const registry = admin.registry;
  if (registry === null) return new Response("assistant registry disabled (no agent home)", { status: 404 });
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
    const id = decodeURIComponent(path.slice("/assistant/registry/".length));
    if (request.method === "PATCH") return Response.json({ changes: registry.update(id, await request.json()) });
    if (request.method === "DELETE") return Response.json(registry.retire(id));
    return new Response("method not allowed", { status: 405 });
  } catch (error) {
    if (error instanceof RegistryError) return new Response(error.message, { status: 400 });
    if (error instanceof AckFailure) return new Response(error.error.message, { status: 400 });
    if (error instanceof SyntaxError) return new Response(`body is not JSON: ${error.message}`, { status: 400 });
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }
}
