// Agents on this Mac drive Relay Desktop on whichever Mac Isaac is using (relay-ctl, relay-mcp):
//
//   GET  /control/devices   {ok, value: {active, devices}}: the desktops that can be driven
//   POST /control/run       {target?, action, params?, confirm?, scope?} -> the desktop's result
//
// Like the desktop's own control API: a loopback peer, a loopback Host (no DNS rebinding), no
// Origin (no web page) and `Authorization: Bearer <controlToken>` from serve.json (0600, so only
// Isaac's user on this Mac reads it). Phones and other devices never reach it: they are not on
// loopback, and `control.req` is not a frame any client may send.

import { timingSafeEqual } from "node:crypto";
import { ControlRequest, type ControlResult } from "@relay/protocol";
import { isLoopback } from "../boards/http";
import type { ControlRelay } from "./relay";

const MAX_BODY = 1_000_000;

/** The desktop control API's statuses, plus the host's own failures. */
const STATUS: Record<string, number> = {
  "invalid-body": 400,
  "invalid-params": 400,
  unauthorized: 401,
  forbidden: 403,
  "confirm-required": 403,
  denied: 403,
  "no-device": 404,
  "unknown-action": 404,
  "too-large": 413,
  "device-gone": 502,
  "device-timeout": 504,
  "renderer-timeout": 504,
};

export function controlStatus(r: ControlResult): number {
  if (r.ok) return r.queued === true ? 202 : 200;
  return STATUS[r.code] ?? 422;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function bearerMatches(header: string | null, token: string): boolean {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "");
  if (m === null) return false;
  const a = Buffer.from(m[1] ?? "");
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const refuse = (status: number, code: string, message: string): Response => Response.json({ ok: false, code, message }, { status });

export async function handleControlRequest(control: ControlRelay | null, request: Request, path: string, remote: string): Promise<Response> {
  if (!isLoopback(remote) || !LOOPBACK_HOSTS.has(new URL(request.url).hostname)) return refuse(403, "forbidden", "Loopback only");
  if (request.headers.has("origin")) return refuse(403, "forbidden", "Browser requests are not allowed");
  if (control === null) return refuse(404, "not-found", "Remote control is off on this host");
  if (!bearerMatches(request.headers.get("authorization"), control.token)) return refuse(401, "unauthorized", "Missing or wrong bearer token");

  if (path === "/control/devices" && request.method === "GET") {
    const devices = control.devices();
    return Response.json({ ok: true, value: { active: devices.find((d) => d.active)?.id ?? null, devices } });
  }
  if (path === "/control/run" && request.method === "POST") {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return refuse(413, "too-large", "Body over 1 MB");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return refuse(400, "invalid-body", "Body is not JSON");
    }
    const parsed = ControlRequest.safeParse(json);
    if (!parsed.success) return refuse(400, "invalid-body", parsed.error.message);
    const { result, device } = await control.run(parsed.data);
    return Response.json({ ...result, device }, { status: controlStatus(result) });
  }
  return refuse(404, "not-found", `No route ${request.method} ${path}`);
}
