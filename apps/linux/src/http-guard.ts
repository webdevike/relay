// One guard for every state-changing loopback HTTP route (audit B3). A loopback peer alone proves
// nothing: any web page open on this Mac can POST to 127.0.0.1 (`text/plain` needs no preflight),
// so a write must also carry the host's bearer token (`controlToken` in serve.json, 0600, which
// no web page can read), come from a loopback `Host` (no DNS rebinding), carry no Origin/Referer
// of another site, and use the content type the route expects (no form posts).

import { isLoopback } from "./boards/http";
import { bearerMatches } from "./control/http";

/** What a route's body must be: JSON, a plain-text line, or bytes (any type but a form post). */
export type WriteBody = "json" | "text" | "blob";

const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

const refuse = (status: number, message: string): Response => Response.json({ error: message }, { status });

/**
 * Null when `request` may write; else the refusal: 403 for a non-loopback peer or Host, or a
 * browser Origin/Referer that is not the host's own origin; 401 without the bearer token; 415 for a
 * body of the wrong type (a DELETE has no body, so no type).
 */
export function guardWrite(request: Request, remote: string, token: string, body: WriteBody): Response | null {
  if (!isLoopback(remote)) return refuse(403, "loopback only");
  const url = new URL(request.url);
  if (LOOPBACK_HOSTS[url.hostname] !== true) return refuse(403, "loopback host only");
  for (const name of ["origin", "referer"]) {
    const value = request.headers.get(name);
    if (value === null) continue;
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      return refuse(403, "browser requests are not allowed");
    }
    if (origin !== url.origin) return refuse(403, "browser requests are not allowed");
  }
  if (!bearerMatches(request.headers.get("authorization"), token)) return refuse(401, "missing or wrong bearer token");
  if (request.method === "DELETE") return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (body === "json" && !type.startsWith("application/json")) return refuse(415, "content-type must be application/json");
  if (body === "text" && !type.startsWith("text/plain")) return refuse(415, "content-type must be text/plain");
  if (body === "blob" && (type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/")))
    return refuse(415, "form posts are not allowed");
  return null;
}
