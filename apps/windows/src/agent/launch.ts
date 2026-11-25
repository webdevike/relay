// `POST /v1/launch`: starts an app on Isaac's desktop, detached from the host, and brings its
// first window to the front. Start-Process (ShellExecute) resolves what the Run box does: an
// .exe path, a name on PATH or in App Paths (`notepad`, `chrome`), a document or a URI.

import type { DesktopWindow } from "../desktop";
import { DEFAULT_TIMEOUT_MS, runCommand } from "./command";

export interface LaunchRequest {
  readonly target: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  /** How long to wait for a new window; 0 returns as soon as it started. Default 15 s. */
  readonly waitMs?: number | undefined;
}

export interface LaunchResult {
  /** The started process, when ShellExecute reported one (URIs and handed-off apps may not). */
  readonly pid: number | null;
  /** Windows that appeared after the launch, the launched process's first. */
  readonly windows: readonly DesktopWindow[];
  /** The window brought to the front, or null when none appeared in time. */
  readonly focused: DesktopWindow | null;
}

export interface LaunchDeps {
  readonly listWindows: () => DesktopWindow[];
  readonly focusWindow: (hwnd: number) => DesktopWindow;
  readonly start: (request: LaunchRequest) => Promise<number | null>;
  readonly sleep: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 250;

/**
 * One argument quoted the way CommandLineToArgvW splits it back: quotes around anything with
 * whitespace or a quote, backslashes doubled only where they precede a quote.
 */
export function quoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      slashes++;
      continue;
    }
    out += "\\".repeat(char === '"' ? slashes * 2 + 1 : slashes) + char;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** Start-Process with every value passed as base64 JSON, so nothing in the request is parsed as PowerShell. */
export async function startProcess(request: LaunchRequest): Promise<number | null> {
  const payload = Buffer.from(
    JSON.stringify({ target: request.target, args: (request.args ?? []).map(quoteArg).join(" "), cwd: request.cwd ?? "" }),
  ).toString("base64");
  const script = [
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "$s = @{ FilePath = $p.target; PassThru = $true; ErrorAction = 'Stop' }",
    "if ($p.args) { $s.ArgumentList = $p.args }",
    "if ($p.cwd) { $s.WorkingDirectory = $p.cwd }",
    "$proc = Start-Process @s",
    "if ($proc) { $proc.Id }",
  ].join("\n");
  const result = await runCommand({ command: script, timeoutMs: DEFAULT_TIMEOUT_MS }, new AbortController().signal);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Start-Process exited ${result.exitCode}`);
  const pid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

/** Launches `request.target`, waits for its window and focuses it. */
export async function launch(request: LaunchRequest, deps: LaunchDeps): Promise<LaunchResult> {
  const before = new Set(deps.listWindows().map((w) => w.hwnd));
  const pid = await deps.start(request);
  const deadline = Date.now() + (request.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const fresh = deps.listWindows().filter((w) => !before.has(w.hwnd));
    if (fresh.length > 0) {
      const ordered = [...fresh.filter((w) => w.pid === pid), ...fresh.filter((w) => w.pid !== pid)];
      const first = ordered[0];
      const focused = first === undefined ? null : deps.focusWindow(first.hwnd);
      return { pid, windows: ordered, focused };
    }
    if (Date.now() >= deadline) return { pid, windows: [], focused: null };
    await deps.sleep(POLL_MS);
  }
}
