// Loopback `POST /query {tool, args}` for Relay Desktop on this Mac and local agents: the same
// QueryService the `query.req` frame and the canvas page reach. Like `/boards` writes it takes only
// `application/json` with no Origin header, so a web page on this machine cannot call it.

import { QueryRequest } from "@relay/protocol";
import { isLoopback } from "../boards/http";
import type { QueryRelaying } from "./service";

/** Reads a `{tool, args}` body and answers the query as `{ok, data}` / `{ok:false, error}`. */
export async function answerQuery(query: QueryRelaying, request: Request, caller: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
  }
  const parsed = QueryRequest.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: "body must be {tool, args?}" }, { status: 400 });
  const answer = await query.run(parsed.data.tool, parsed.data.args ?? {}, caller);
  return Response.json(answer, { status: answer.ok ? 200 : 422 });
}

export async function handleQueryRequest(query: QueryRelaying | null, request: Request, remote: string): Promise<Response> {
  if (!isLoopback(remote)) return Response.json({ ok: false, error: "loopback only" }, { status: 403 });
  if (query === null) return Response.json({ ok: false, error: "queries disabled" }, { status: 404 });
  if (request.method !== "POST") return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  if (request.headers.has("origin")) return Response.json({ ok: false, error: "browser requests are not allowed" }, { status: 403 });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return Response.json({ ok: false, error: "content-type must be application/json" }, { status: 415 });
  return answerQuery(query, request, "loopback");
}
