// The agent channel: an HTTP API on 127.0.0.1 that agents on the Mac Mini reach through an SSH
// forward (`.omp/tools/pc.ts` in Eva). Every request carries `Authorization: Bearer <token>`, the
// 64-hex key in `%USERPROFILE%\.relay\agent.key`. It never listens on another interface: the
// tunnel is the only way in from outside the PC.
//
//   GET  /v1/health                       {ok, version, pid}
//   POST /v1/run      {command, cwd?, timeoutMs?}        PowerShell; RunResult
//   POST /v1/launch   {target, args?, cwd?, waitMs?}     LaunchResult
//   GET  /v1/windows                      DesktopWindow[]
//   POST /v1/focus    {window}            hwnd or title substring; DesktopWindow
//   GET  /v1/shot[?window=<hwnd|title>]   image/png; X-Relay-Rect: x,y,width,height
//   GET  /v1/clipboard                    {text}   (null when it holds no text)
//   PUT  /v1/clipboard {text}

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DesktopWindow, Screenshot } from "../desktop";
import { MAX_TIMEOUT_MS, type RunRequest, type RunResult } from "./command";
import type { LaunchRequest, LaunchResult } from "./launch";

export interface AgentDeps {
  readonly token: string;
  readonly version: string;
  readonly run: (request: RunRequest, signal: AbortSignal) => Promise<RunResult>;
  /** Throws a caller-facing message when `request` cannot run (a missing cwd). */
  readonly checkRun: (request: RunRequest) => void;
  readonly launch: (request: LaunchRequest) => Promise<LaunchResult>;
  readonly windows: () => DesktopWindow[];
  readonly focus: (hwnd: number) => DesktopWindow;
  readonly shotScreen: () => Screenshot;
  readonly shotWindow: (hwnd: number) => Screenshot;
  readonly readClipboard: () => Promise<string | null>;
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly log: (line: string) => void;
}

const RunBody = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});
const LaunchBody = z.object({
  target: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  waitMs: z.number().int().min(0).max(120_000).optional(),
});
const FocusBody = z.object({ window: z.string().min(1) });
const ClipboardBody = z.object({ text: z.string() });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** Constant-time check of `Authorization: Bearer <token>`. */
export function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

/** The one window `target` names: an hwnd, or a title substring matching exactly one window (the front one wins ties of equal titles). */
export function pickWindow(windows: readonly DesktopWindow[], target: string): DesktopWindow {
  const hwnd = /^(0x[0-9a-f]+|\d+)$/i.test(target) ? Number(target) : null;
  if (hwnd !== null) {
    const match = windows.find((w) => w.hwnd === hwnd);
    if (match === undefined) throw new HttpError(404, `no window ${target}`);
    return match;
  }
  const needle = target.toLowerCase();
  const matches = windows.filter((w) => w.title.toLowerCase().includes(needle));
  const first = matches[0];
  if (first === undefined) throw new HttpError(404, `no window title contains ${JSON.stringify(target)}`);
  if (matches.some((w) => w.title !== first.title))
    throw new HttpError(409, `${matches.length} windows match ${JSON.stringify(target)}: ${matches.map((w) => `${w.hwnd} ${JSON.stringify(w.title)}`).join(", ")}`);
  return first;
}

function png(shot: Screenshot): Response {
  const { x, y, width, height } = shot.rect;
  return new Response(shot.png, {
    headers: { "content-type": "image/png", "x-relay-rect": `${x},${y},${width},${height}`, "x-relay-black": shot.black ? "1" : "0" },
  });
}

async function route(request: Request, deps: AgentDeps): Promise<Response> {
  const url = new URL(request.url);
  const at = `${request.method} ${url.pathname}`;
  switch (at) {
    case "GET /v1/health":
      return json({ ok: true, version: deps.version, pid: process.pid });
    case "POST /v1/run": {
      const run = await body(request, RunBody);
      try {
        deps.checkRun(run);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      return json(await deps.run(run, request.signal));
    }
    case "POST /v1/launch":
      return json(await deps.launch(await body(request, LaunchBody)));
    case "GET /v1/windows":
      return json(deps.windows());
    case "POST /v1/focus": {
      const { window } = await body(request, FocusBody);
      return json(deps.focus(pickWindow(deps.windows(), window).hwnd));
    }
    case "GET /v1/shot": {
      const window = url.searchParams.get("window");
      return png(window === null ? deps.shotScreen() : deps.shotWindow(pickWindow(deps.windows(), window).hwnd));
    }
    case "GET /v1/clipboard":
      return json({ text: await deps.readClipboard() });
    case "PUT /v1/clipboard":
      await deps.writeClipboard((await body(request, ClipboardBody)).text);
      return json({ ok: true });
    default:
      throw new HttpError(404, `no route ${at}`);
  }
}

/** The channel's request handler (no listener), for `Bun.serve` and tests. */
export function agentHandler(deps: AgentDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const started = Date.now();
    const { pathname } = new URL(request.url);
    let response: Response;
    if (!authorized(request, deps.token)) {
      response = json({ error: "unauthorized" }, 401);
    } else {
      try {
        response = await route(request, deps);
      } catch (error) {
        response =
          error instanceof HttpError
            ? json({ error: error.message }, error.status)
            : json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    // Paths and status only: commands, clipboard text and window titles stay out of the log.
    deps.log(`agent ${request.method} ${pathname} ${response.status} ${Date.now() - started} ms`);
    return response;
  };
}

/** Listens on 127.0.0.1:`port` only. Requests may run for up to an hour (`run`), so no idle timeout. */
export function startAgentServer(port: number, deps: AgentDeps): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: agentHandler(deps) });
  return server.port ?? port;
}
