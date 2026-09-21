// Opens a phone-started omp session inside Herdr (the terminal workspace manager Isaac keeps his
// sessions in): every session gets its own workspace, so the workspace list reads like the
// phone's inbox. Herdr's default server is started headless in its own transient systemd user
// unit when it is not running: it outlives this daemon (a `setsid` child would still die with
// the service cgroup), and a later `herdr` attaches to it.
//
// The pane runs the user's interactive shell, so `omp` resolves through the shell's PATH rather
// than the service's; only `herdr` itself must be reachable from here.

import { basename } from "node:path";
import { z } from "zod";
import { AckFailure } from "../seams";

const SERVER_START_TIMEOUT_MS = 5000;
const SERVER_POLL_MS = 250;
const AGENT_START_TIMEOUT_MS = 30000;
/** Transient unit that owns a server this daemon had to start; `--collect` lets the name be reused. */
const SERVER_UNIT = "herdr-server";

const Reply = z.object({
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const WorkspaceList = z.object({ workspaces: z.array(z.object({ workspace_id: z.string() })) });
const WorkspaceCreated = z.object({ root_pane: z.object({ pane_id: z.string() }) });

class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(message: string): AckFailure {
  return new AckFailure({ code: "agent_launch_failed", message });
}

async function herdr(args: readonly string[]): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["herdr", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Server errors are JSON on stderr with exit 1; syntax errors are plain text with exit 2.
  const raw = (code === 0 ? stdout : stderr).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HerdrError("herdr_output", raw.length > 0 ? raw : `herdr ${args[0]} exited ${code}`);
  }
  const reply = Reply.safeParse(parsed);
  if (!reply.success) throw new HerdrError("herdr_output", `unexpected herdr reply: ${raw}`);
  if (reply.data.error !== undefined) throw new HerdrError(reply.data.error.code, reply.data.error.message);
  return reply.data.result ?? {};
}

function result<T>(schema: z.ZodType<T>, value: Record<string, unknown>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HerdrError("herdr_output", `unexpected herdr reply: ${JSON.stringify(value)}`);
  return parsed.data;
}

/** Workspaces of the running default server, starting it headless first when nothing answers. */
async function ensureServer(log: (line: string) => void): Promise<z.infer<typeof WorkspaceList>["workspaces"]> {
  try {
    return result(WorkspaceList, await herdr(["workspace", "list"])).workspaces;
  } catch (error) {
    if (!(error instanceof HerdrError) || error.code !== "server_not_running") throw error;
  }
  const proc = Bun.spawn(
    ["systemd-run", "--user", "--collect", "--quiet", `--unit=${SERVER_UNIT}`, "herdr", "server"],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw fail(`could not start the herdr server: ${stderr.length > 0 ? stderr : "systemd-run failed"}`);
  }
  log(`started headless herdr server (systemd user unit ${SERVER_UNIT})`);
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  for (;;) {
    await Bun.sleep(SERVER_POLL_MS);
    try {
      return result(WorkspaceList, await herdr(["workspace", "list"])).workspaces;
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "server_not_running") throw error;
      if (Date.now() >= deadline) throw fail("the herdr server did not come up in time");
    }
  }
}

/**
 * Creates a workspace for `home` (labelled after it, so several read "Eva", "Eva", "Eva" in
 * herdr's list until omp titles the pane) and starts omp in its root pane. Resolves with the
 * pane id; rejects with `AckFailure` (`agent_launch_failed`).
 */
export async function launchInHerdr(home: string, log: (line: string) => void): Promise<string> {
  if (Bun.which("herdr") === null) throw fail("herdr is not installed on the host (not on PATH)");
  try {
    await ensureServer(log);
    const label = basename(home);
    const paneId = result(
      WorkspaceCreated,
      await herdr(["workspace", "create", "--cwd", home, "--label", label, "--env", "RELAY_HERDR_OWNED=1", "--no-focus"]),
    ).root_pane.pane_id;
    const name = `relay-${Date.now().toString(36)}`;
    await herdr(["agent", "start", name, "--kind", "omp", "--pane", paneId, "--timeout", String(AGENT_START_TIMEOUT_MS)]);
    return paneId;
  } catch (error) {
    if (error instanceof AckFailure) throw error;
    if (error instanceof HerdrError) throw fail(`herdr: ${error.message}`);
    throw error;
  }
}
