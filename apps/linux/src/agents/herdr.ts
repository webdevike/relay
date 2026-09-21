// Opens a phone-started omp session inside Herdr (the terminal workspace manager Isaac keeps his
// sessions in) so every session lives in one place: a sibling pane in the workspace's active
// tab, next to the agents already there, never a new tab. Herdr's default server is started
// headless in its own transient systemd user unit when it is not running: it outlives this
// daemon (a `setsid` child would still die with the service cgroup), and a later `herdr`
// attaches to it.
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

const WorkspaceList = z.object({
  workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string(), active_tab_id: z.string().nullable().optional() })),
});
const WorkspaceCreated = z.object({ workspace: z.object({ workspace_id: z.string() }), root_pane: z.object({ pane_id: z.string() }) });
const PaneList = z.object({ panes: z.array(z.object({ pane_id: z.string(), tab_id: z.string() })) });
const Rect = z.object({ width: z.number(), height: z.number() });
const PaneLayout = z.object({ layout: z.object({ panes: z.array(z.object({ pane_id: z.string(), rect: Rect })) }) });
const PaneSplit = z.object({ pane: z.object({ pane_id: z.string() }) });
const TabCreated = z.object({ root_pane: z.object({ pane_id: z.string() }) });

export interface PaneRect {
  pane_id: string;
  rect: { width: number; height: number };
}

export type SplitPlan = { pane_id: string; direction: "right" | "down" } | null;

/** A split must leave both halves usable: at least this many columns or rows each. */
const MIN_COLS = 70;
const MIN_ROWS = 18;

/**
 * Where a new agent fits in a tab: the largest pane, split to the right when it is wide (a
 * terminal cell is about twice as tall as it is wide) and down otherwise. `null` when even the
 * largest pane would leave halves too small to work in; the caller opens a tab instead.
 */
export function planSplit(panes: readonly PaneRect[]): SplitPlan {
  let best: PaneRect | undefined;
  for (const pane of panes) {
    if (best === undefined || pane.rect.width * pane.rect.height > best.rect.width * best.rect.height) best = pane;
  }
  if (best === undefined) return null;
  const { width, height } = best.rect;
  if (width >= 2 * MIN_COLS && width >= 2 * height) return { pane_id: best.pane_id, direction: "right" };
  if (height >= 2 * MIN_ROWS) return { pane_id: best.pane_id, direction: "down" };
  if (width >= 2 * MIN_COLS) return { pane_id: best.pane_id, direction: "right" };
  return null;
}

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
 * Starts omp in a fresh pane of the workspace named after `home` (created when missing): a
 * sibling of the active tab's largest pane, or that workspace's root pane when it was just
 * created, or a new tab only when every pane is already too small to share. Resolves with the
 * pane id; rejects with `AckFailure` (`agent_launch_failed`).
 */
export async function launchInHerdr(home: string, log: (line: string) => void): Promise<string> {
  if (Bun.which("herdr") === null) throw fail("herdr is not installed on the host (not on PATH)");
  try {
    const workspaces = await ensureServer(log);
    const label = basename(home).toLowerCase();
    const workspace = workspaces.find((candidate) => candidate.label.toLowerCase() === label);
    let paneId: string;
    if (workspace === undefined) {
      paneId = result(WorkspaceCreated, await herdr(["workspace", "create", "--cwd", home, "--no-focus"])).root_pane.pane_id;
    } else {
      paneId = await openPane(workspace.workspace_id, workspace.active_tab_id ?? null, home);
    }
    const name = `relay-${Date.now().toString(36)}`;
    await herdr(["agent", "start", name, "--kind", "omp", "--pane", paneId, "--timeout", String(AGENT_START_TIMEOUT_MS)]);
    return paneId;
  } catch (error) {
    if (error instanceof AckFailure) throw error;
    if (error instanceof HerdrError) throw fail(`herdr: ${error.message}`);
    throw error;
  }
}

/** A new shell pane in `tabId` (the largest pane split), falling back to a new tab. */
async function openPane(workspaceId: string, tabId: string | null, home: string): Promise<string> {
  if (tabId !== null) {
    const panes = result(PaneList, await herdr(["pane", "list", "--workspace", workspaceId])).panes.filter((pane) => pane.tab_id === tabId);
    const anchor = panes[0];
    if (anchor !== undefined) {
      const layout = result(PaneLayout, await herdr(["pane", "layout", "--pane", anchor.pane_id])).layout.panes;
      const plan = planSplit(layout);
      if (plan !== null) {
        return result(PaneSplit, await herdr(["pane", "split", "--pane", plan.pane_id, "--direction", plan.direction, "--cwd", home, "--no-focus"])).pane.pane_id;
      }
    }
  }
  return result(TabCreated, await herdr(["tab", "create", "--workspace", workspaceId, "--cwd", home, "--no-focus"])).root_pane.pane_id;
}
