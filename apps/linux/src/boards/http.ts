// Loopback-only JSON API for live dashboards, used by `relay-linux board ...` and local agents.
// Kept off the Bun.serve wiring so it runs on plain `Request`/`Response` (and in tests).

import { BoardShareCreate } from "@relay/protocol";
import { SHARE_PREFIX } from "./share-page";
import type { BoardShares } from "./shares";
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
 * GET /boards, GET|PUT|DELETE /boards/<slug>, POST /boards/<slug>/ops, GET|POST
 * /boards/<slug>/shares, DELETE /boards/<slug>/shares/<token>. Answers `{rev, boards}`, `{rev,
 * board?}`, `{shares}` or `{share}` (each share with its `path` and, when the tailnet name is known,
 * its `url`); a bad body is 400 `{error}`, an unknown board 404 `{error}`. Writes must be
 * `application/json` with no Origin header: a browser page on this machine passes the loopback
 * check, but can only send a no-preflight POST as text/plain and always attaches Origin.
 */
export async function handleBoardRequest(
  boards: FileBoardStore | null,
  request: Request,
  path: string,
  remote: string,
  shares: { store: BoardShares; origin: () => string | null } | null = null,
): Promise<Response> {
  if (!isLoopback(remote)) return Response.json({ error: "loopback only" }, { status: 403 });
  if (boards === null) return Response.json({ error: "boards disabled" }, { status: 404 });
  const [, , slug, tail, token, ...rest] = path.split("/");
  if (
    rest.length > 0 ||
    (tail !== undefined && tail !== "ops" && tail !== "shares") ||
    (token !== undefined && tail !== "shares")
  )
    return Response.json({ error: "not found" }, { status: 404 });
  const method = request.method;
  if (method !== "GET") {
    if (request.headers.has("origin"))
      return Response.json({ error: "browser requests are not allowed" }, { status: 403 });
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  }
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
    if (tail === "shares") {
      if (shares === null) return Response.json({ error: "shares disabled" }, { status: 404 });
      const origin = shares.origin();
      const view = (share: { token: string }) => ({
        ...share,
        path: `${SHARE_PREFIX}${share.token}`,
        ...(origin === null ? {} : { url: `${origin}${SHARE_PREFIX}${share.token}` }),
      });
      if (token !== undefined) {
        if (method !== "DELETE")
          return Response.json({ error: "method not allowed" }, { status: 405 });
        if (!shares.store.revoke(slug, token))
          return Response.json({ error: `no share ${token} of ${slug}` }, { status: 404 });
        return Response.json({ revoked: token });
      }
      if (method === "GET") return Response.json({ shares: shares.store.list(slug).map(view) });
      if (method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
      const body = BoardShareCreate.safeParse(await jsonBody(request));
      if (!body.success)
        return Response.json(
          { error: body.error.issues.map((issue) => issue.message).join("; ") },
          { status: 400 },
        );
      return Response.json({ share: view(shares.store.create(slug, body.data.tab)) });
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
    if (error instanceof BoardError)
      return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
