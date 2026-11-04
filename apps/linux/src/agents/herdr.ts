// Opens a phone-started omp session inside Herdr (the terminal workspace manager the host's owner
// keeps their sessions in): every session gets its own workspace, so the workspace list reads like the
// phone's inbox. Herdr's default server is started headless when it is not running: on Linux in
// its own transient systemd user unit (it outlives this daemon; a `setsid` child would still die
// with the service cgroup), on macOS through the per-user LaunchAgent `dev.relay.herdr` (written
// here when missing; the owner's own `ai.eva.herdr` agent is never touched). A later `herdr`
// attaches to it.
//
// The host may be started without a login shell's PATH (a login item, launchd), so `herdr` is
// resolved from PATH plus ~/.local/bin, ~/.bun/bin and the Homebrew dirs, and the child's PATH
// carries the same dirs so the pane's shell finds `omp` and `bun` too.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { resolveTool, toolPath } from "../host-config";
import { AckFailure } from "../seams";

/** Label of the LaunchAgent this host writes for herdr's server (macOS). */
export const HERDR_LAUNCH_LABEL = "dev.relay.herdr";
/** The owner's pre-existing herdr LaunchAgent: when its plist exists it restarts the server itself. */
const LEGACY_HERDR_LABEL = "ai.eva.herdr";

const SERVER_START_TIMEOUT_MS = 5000;
const SERVER_POLL_MS = 250;
const AGENT_START_TIMEOUT_MS = 30000;
/** Transient unit that owns a server this daemon had to start; `--collect` lets the name be reused. */
const SERVER_UNIT = "herdr-server";
/**
 * A named omp profile isolates extension discovery too, so its session would never join herdr or
 * this host. Profiled sessions load the shared config baseline and these managed integrations from
 * `~/.omp/agent` while credentials and transcripts stay in the profile (as EvaOS does).
 */
const PROFILE_INTEGRATIONS = ["herdr-omp-agent-state.ts", "relay-bridge.ts"];
/** Waiting for a new pane's shell: up to 10 tries, 500 ms apart. */
const SHELL_READY_ATTEMPTS = 10;
const SHELL_READY_POLL_MS = 500;

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
  const bin = resolveTool("herdr");
  if (bin === null) throw new HerdrError("herdr_missing", "herdr is not installed on the host (not on PATH)");
  const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: toolPath() } });
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

function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Starts `herdr server` through the user's `dev.relay.herdr` LaunchAgent (plist written when missing), else detached. */
async function startServerMac(bin: string, log: (line: string) => void): Promise<void> {
  if (existsSync(join(launchAgentsDir(), `${LEGACY_HERDR_LABEL}.plist`))) {
    log(`herdr server is not running; ${LEGACY_HERDR_LABEL} owns it and will restart it`);
    return;
  }
  const plist = join(launchAgentsDir(), `${HERDR_LAUNCH_LABEL}.plist`);
  const logPath = join(homedir(), "Library", "Logs", "RelayHerdr.log");
  if (!existsSync(plist)) {
    mkdirSync(launchAgentsDir(), { recursive: true });
    mkdirSync(join(homedir(), "Library", "Logs"), { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${HERDR_LAUNCH_LABEL}</string>
<key>ProgramArguments</key><array><string>${xmlEscape(bin)}</string><string>server</string></array>
<key>WorkingDirectory</key><string>${xmlEscape(homedir())}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlEscape(toolPath(""))}</string><key>SHELL</key><string>${xmlEscape(process.env["SHELL"] ?? "/bin/zsh")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xmlEscape(logPath)}</string><key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>
`,
    );
  }
  const domain = `gui/${String(process.getuid?.() ?? 501)}`;
  const boot = Bun.spawn(["/bin/launchctl", "bootstrap", domain, plist], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if ((await boot.exited) === 0) {
    log(`started herdr server (LaunchAgent ${HERDR_LAUNCH_LABEL})`);
    return;
  }
  // Already bootstrapped (it exited and is throttled) or no GUI domain: kick it, else run it detached.
  const kick = Bun.spawn(["/bin/launchctl", "kickstart", `${domain}/${HERDR_LAUNCH_LABEL}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await kick.exited) === 0) {
    log(`started herdr server (kickstarted ${HERDR_LAUNCH_LABEL})`);
    return;
  }
  const detached = Bun.spawn([bin, "server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, PATH: toolPath() }, detached: true });
  detached.unref();
  log("started herdr server (detached process; launchctl was unavailable)");
}

async function startServerLinux(log: (line: string) => void): Promise<void> {
  const proc = Bun.spawn(
    ["systemd-run", "--user", "--collect", "--quiet", `--unit=${SERVER_UNIT}`, "herdr", "server"],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw fail(`could not start the herdr server: ${stderr.length > 0 ? stderr : "systemd-run failed"}`);
  }
  log(`started headless herdr server (systemd user unit ${SERVER_UNIT})`);
}

/** Workspaces of the running default server, starting it headless first when nothing answers. */
async function ensureServer(bin: string, log: (line: string) => void): Promise<z.infer<typeof WorkspaceList>["workspaces"]> {
  try {
    return result(WorkspaceList, await herdr(["workspace", "list"])).workspaces;
  } catch (error) {
    if (!(error instanceof HerdrError) || error.code !== "server_not_running") throw error;
  }
  if (process.platform === "darwin") await startServerMac(bin, log);
  else await startServerLinux(log);
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

/** How the pane's omp is started; the fields are independent and all optional. */
export interface LaunchOptions {
  /** Submitted as the first turn once omp is up (rides in the pane env as `RELAY_INITIAL_PROMPT`). */
  readonly prompt?: string;
  /** The session's thinking level (`RELAY_THINKING_LEVEL`). */
  readonly thinkingLevel?: string;
  /** A named omp profile, passed after herdr's `--` separator. */
  readonly profile?: "personal" | "work";
  /** The model omp starts on (`omp --model <id>`), passed after herdr's `--` separator. */
  readonly model?: string;
  /** Extra pane env, e.g. `RELAY_ASSISTANT=<id>` for an assistant thread. */
  readonly env?: Readonly<Record<string, string>>;
  /** An omp session file to resume (`omp --resume <file>`) instead of starting a new transcript. */
  readonly resume?: string;
  /** The herdr workspace label (an assistant thread's title, e.g. "Astra"); default basename(home). */
  readonly label?: string;
  /** Further omp flags after the others, e.g. `--no-title` for a session the host names itself. */
  readonly ompArgs?: readonly string[];
}

/**
 * Creates a workspace for `home` (labelled `label`, else after `home`, so several read "Eva",
 * "Eva", "Eva" in herdr's list until omp titles the pane) and starts omp in its root pane. `prompt`, when given,
 * goes into the pane's env as `RELAY_INITIAL_PROMPT` for the session's bridge to submit as the
 * first turn; `thinkingLevel` likewise as `RELAY_THINKING_LEVEL`. A named `profile` and a
 * `resume` target are passed to omp after herdr's `--` separator. Resolves with the pane id;
 * rejects with `AckFailure` (`agent_launch_failed`).
 */
export async function launchInHerdr(home: string, log: (line: string) => void, options: LaunchOptions = {}): Promise<string> {
  const bin = resolveTool("herdr");
  if (bin === null) throw fail("herdr is not installed on the host (not on PATH, ~/.local/bin, ~/.bun/bin or Homebrew)");
  try {
    await ensureServer(bin, log);
    const label = options.label ?? basename(home);
    const env = ["--env", "RELAY_HERDR_OWNED=1"];
    // A host on its own bridge socket or port (a second, throwaway host) points the omps it starts at itself, not at the default host.
    for (const key of ["RELAY_AGENTS_SOCKET", "RELAY_HOST_URL"]) {
      const value = process.env[key];
      if (value !== undefined && value !== "") env.push("--env", `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(options.env ?? {})) env.push("--env", `${key}=${value}`);
    if (options.prompt !== undefined) env.push("--env", `RELAY_INITIAL_PROMPT=${options.prompt}`);
    if (options.thinkingLevel !== undefined) env.push("--env", `RELAY_THINKING_LEVEL=${options.thinkingLevel}`);
    const paneId = result(
      WorkspaceCreated,
      await herdr(["workspace", "create", "--cwd", home, "--label", label, ...env, "--no-focus"]),
    ).root_pane.pane_id;
    const name = `relay-${Date.now().toString(36)}`;
    const ompArgs = [
      ...(options.profile === undefined ? [] : ["--profile", options.profile, ...profileIntegrations()]),
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.resume === undefined ? [] : [`--resume=${options.resume}`]),
      ...(options.ompArgs ?? []),
    ];
    const start = ["agent", "start", name, "--kind", "omp", "--pane", paneId, "--timeout", String(AGENT_START_TIMEOUT_MS), ...(ompArgs.length === 0 ? [] : ["--", ...ompArgs])];
    // A fresh workspace's shell can still be starting (slow rc files); herdr refuses the pane until its prompt is up.
    for (let attempt = 1; ; attempt++) {
      try {
        await herdr(start);
        break;
      } catch (error) {
        if (!(error instanceof HerdrError) || !error.message.includes("not an available shell") || attempt === SHELL_READY_ATTEMPTS) throw error;
        await Bun.sleep(SHELL_READY_POLL_MS);
      }
    }
    return paneId;
  } catch (error) {
    if (error instanceof AckFailure) throw error;
    if (error instanceof HerdrError) throw fail(`herdr: ${error.message}`);
    throw error;
  }
}

/**
 * Closes herdr pane `paneId`, which ends the process running in it. Rejects with `AckFailure`
 * (`agent_launch_failed`) when herdr is missing or refuses.
 */
export async function closeHerdrPane(paneId: string): Promise<void> {
  try {
    await herdr(["pane", "close", paneId]);
  } catch (error) {
    if (error instanceof HerdrError) throw fail(`herdr: ${error.message}`);
    throw error;
  }
}

function profileIntegrations(): string[] {
  const agent = join(homedir(), ".omp", "agent");
  const args = ["--config", join(agent, "config.yml")];
  for (const name of PROFILE_INTEGRATIONS) {
    const path = join(agent, "extensions", name);
    if (!existsSync(path)) throw fail(`missing omp integration for profiled sessions: ${path}`);
    args.push("--extension", path);
  }
  return args;
}
