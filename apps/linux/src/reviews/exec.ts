// The processes and files Reviews reads with: `gh` and `claude` resolved past launchd's thin PATH,
// one runner with a deadline, and the JSON files under `$XDG_CONFIG_HOME/relay/reviews` (0600).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ToolResult {
  /** null when it was killed at the deadline. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Runs `argv` in `cwd` with extra env; SIGKILL at the deadline. Never rejects for a non-zero exit. */
export type ToolRun = (argv: readonly string[], options: { readonly cwd: string; readonly timeoutMs: number; readonly env?: Readonly<Record<string, string>> }) => Promise<ToolResult>;

export function defaultReviewsDir(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "relay", "reviews");
}

/** `gh` on PATH, else Homebrew's. */
export function resolveGh(): string {
  return Bun.which("gh") ?? "/opt/homebrew/bin/gh";
}

/** `claude`: `$RELAY_CLAUDE`, `~/.local/bin/claude`, Homebrew's, then PATH. */
export function resolveClaude(): string {
  const override = process.env["RELAY_CLAUDE"];
  if (override !== undefined && override !== "") return override;
  for (const candidate of [join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude"]) {
    if (existsSync(candidate)) return candidate;
  }
  return Bun.which("claude") ?? "claude";
}

export const bunRun: ToolRun = async (argv, options) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...argv], {
      cwd: options.cwd,
      // launchd starts the host with a bare PATH: add Homebrew's and user installs.
      env: { ...process.env, PATH: [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env["PATH"] ?? "/usr/bin:/bin"].join(":"), ...options.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
  }
  const deadline = { hit: false };
  const timer = setTimeout(() => {
    deadline.hit = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code: deadline.hit ? null : code, stdout, stderr, timedOut: deadline.hit };
  } finally {
    clearTimeout(timer);
  }
};

/** A JSON file's value, or `fallback` when it is missing or unreadable. */
export function readJson(path: string, fallback: unknown): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return fallback;
  }
}

/** Replaces `path` atomically, readable by the user only. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
