// Loopback-only JSON API for live dashboards, used by `relay-linux board ...` and local agents.
// Kept off the Bun.serve wiring so it runs on plain `Request`/`Response` (and in tests).

import { BoardError, type FileBoardStore } from "./store";

export function isLoopback(remote: string): boolean {
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BoardError(400, "body is not JSON");
  }
}

/**
 * GET /boards, GET|PUT|DELETE /boards/<slug>, POST /boards/<slug>/ops. Answers `{rev, boards}`
 * or `{rev, board?}`; a bad body is 400 `{error}`, an unknown board 404 `{error}`.
 */
export async function handleBoardRequest(
  boards: FileBoardStore | null,
  request: Request,
  path: string,
  remote: string,
): Promise<Response> {
  if (!isLoopback(remote)) return Response.json({ error: "loopback only" }, { status: 403 });
  if (boards === null) return Response.json({ error: "boards disabled" }, { status: 404 });
  const [, , slug, tail, ...rest] = path.split("/");
  if (rest.length > 0 || (tail !== undefined && tail !== "ops"))
    return Response.json({ error: "not found" }, { status: 404 });
  const method = request.method;
  try {
    if (slug === undefined || slug === "") {
      if (method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 });
      return Response.json({ rev: boards.rev, boards: boards.list() });
    }
    if (tail === "ops") {
      if (method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
      const board = await boards.apply(slug, await jsonBody(request));
      return Response.json({ rev: boards.rev, board });
    }
    if (method === "GET") {
      const board = boards.get(slug);
      if (board === null) return Response.json({ error: `no board ${slug}` }, { status: 404 });
      return Response.json({ rev: boards.rev, board });
    }
    if (method === "PUT") {
      const board = await boards.put(slug, await jsonBody(request));
      return Response.json({ rev: boards.rev, board });
    }
    if (method === "DELETE") {
      await boards.remove(slug);
      return Response.json({ rev: boards.rev });
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  } catch (error) {
    if (error instanceof BoardError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
