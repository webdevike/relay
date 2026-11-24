// Loopback-only routes behind `relay-host call-me` (an assistant's session runs them when Isaac asks
// to be called):
//   - `GET /assistant/call-me[?agent=<id>][&all=1]` lists requests (open ones; `all` adds ended ones);
//   - `POST /assistant/call-me` (JSON `CallMeAdd`) registers one and answers it once its work was found;
//   - `POST /assistant/call-me/cancel` (JSON `{ agent?, id? }`) cancels one, or every open one of `agent`;
//   - `POST /assistant/call-me/settle` (JSON `{ id, status, result }`) settles one whose work the host
//     cannot see (`--on manual`).

import { z } from "zod";
import { isLoopback } from "../boards/http";
import { CallMeAdd, CallMeError, type CallMeService } from "./service";

const CancelBody = z.object({ agent: z.string().min(1).optional(), id: z.string().min(1).optional() });
const SettleBody = z.object({ id: z.string().min(1), status: z.enum(["done", "failed"]), result: z.string().max(20_000) });

export function isCallMePath(path: string): boolean {
  return path === "/assistant/call-me" || path.startsWith("/assistant/call-me/");
}

async function fields<T>(request: Request, schema: z.ZodType<T>, expected: string): Promise<T | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("body is not JSON", { status: 400 });
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : new Response(`expected ${expected}`, { status: 400 });
}

export async function handleCallMe(callMe: CallMeService | null, request: Request, remote: string, path: string): Promise<Response> {
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  if (callMe === null) return new Response("call-me disabled", { status: 404 });
  try {
    if (path === "/assistant/call-me" && request.method === "GET") {
      const query = new URL(request.url).searchParams;
      const agent = query.get("agent");
      return Response.json({ requests: callMe.list(agent === null || agent === "" ? undefined : agent, query.get("all") === "1") });
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (path === "/assistant/call-me") {
      const input = await fields(request, CallMeAdd, "{agent, about, on?, session?}");
      if (input instanceof Response) return input;
      return Response.json({ request: await callMe.add(input) }, { status: 201 });
    }
    if (path === "/assistant/call-me/cancel") {
      const input = await fields(request, CancelBody, "{agent?, id?}");
      if (input instanceof Response) return input;
      if (input.agent === undefined && input.id === undefined) return new Response("expected an id or an agent", { status: 400 });
      return Response.json({ cancelled: callMe.cancel(input.agent, input.id) });
    }
    if (path === "/assistant/call-me/settle") {
      const input = await fields(request, SettleBody, "{id, status: done|failed, result}");
      if (input instanceof Response) return input;
      return callMe.settle(input.id, { status: input.status, result: input.result })
        ? Response.json({ ok: true })
        : new Response(`no call request ${input.id} waiting on its work`, { status: 404 });
    }
    return new Response("not found", { status: 404 });
  } catch (error) {
    if (error instanceof CallMeError) return new Response(error.message, { status: 400 });
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }
}
