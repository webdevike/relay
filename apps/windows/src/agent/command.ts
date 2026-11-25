// Runs an agent's PowerShell command inside Isaac's session (the host's own session): the
// command machine's real `process` actor plus the request/result shapes of `POST /v1/run`.

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createActor, fromCallback, toPromise } from "xstate";
import { commandMachine, type CommandExit, type ProcessCommand } from "./command.machine";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 60 * 60_000;
const KILL_GRACE_MS = 3_000;
/** Per stream; the rest is dropped and `truncated` set, so a runaway command cannot fill the host's memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface RunRequest {
  /** PowerShell source; may span lines. */
  readonly command: string;
  /** Working directory; the user's profile when absent. */
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface RunResult {
  readonly outcome: "exited" | "timedOut" | "cancelled";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/**
 * UTF-8 in both directions and no progress records. After the script: a native command's non-zero
 * `$LASTEXITCODE` is the exit code, else 1 when the last statement failed; an explicit `exit N` in
 * the script wins.
 */
export function wrapScript(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$OutputEncoding = [Text.Encoding]::UTF8",
    command,
    "$__relayOk = $?",
    "if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "if (-not $__relayOk) { exit 1 }",
    "exit 0",
  ].join("\n");
}

/**
 * The PowerShell invocation for `script`: `-File` on a UTF-8-with-BOM copy (Windows PowerShell reads a
 * BOM-less file as the ANSI code page) in a fresh temp dir that `cleanup` removes. Not
 * `-EncodedCommand`: with redirected pipes it writes errors and progress to stderr as CLIXML, and
 * the command line caps it at 32767 characters.
 */
export function powershellInvocation(script: string): { argv: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "relay-run-"));
  const file = join(dir, "run.ps1");
  writeFileSync(file, `\uFEFF${script}`, "utf8");
  return {
    argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Kills `pid` and every process it started. */
export function killTree(pid: number): void {
  Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
}

async function collect(stream: ReadableStream<Uint8Array>, onTruncate: () => void): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const room = MAX_OUTPUT_BYTES - size;
    if (chunk.length > room) onTruncate();
    if (room <= 0) continue;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    chunks.push(kept);
    size += kept.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Throws a message meant for the caller when the request cannot run. */
export function checkRunRequest(request: RunRequest): void {
  if (request.cwd !== undefined && !(existsSync(request.cwd) && statSync(request.cwd).isDirectory()))
    throw new Error(`cwd ${request.cwd} is not a directory`);
}

/** Runs `request` to completion; `signal` aborting (the agent hung up) kills it. */
export async function runCommand(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
  const started = Date.now();
  let truncated = false;
  const markTruncated = (): void => {
    truncated = true;
  };
  const powershell = fromCallback<ProcessCommand>(({ sendBack, receive }) => {
    const { argv, cleanup } = powershellInvocation(wrapScript(request.command));
    const child = Bun.spawn(argv, {
      cwd: request.cwd ?? homedir(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    void Promise.all([collect(child.stdout, markTruncated), collect(child.stderr, markTruncated), child.exited]).then(
      ([stdout, stderr, code]) => {
        cleanup();
        const exit: CommandExit = { exitCode: child.signalCode === null ? code : null, stdout, stderr };
        sendBack({ type: "process.exited", exit });
      },
    );
    receive(() => {
      killTree(child.pid);
    });
    return () => {
      if (child.exitCode === null && child.signalCode === null) killTree(child.pid);
    };
  });
  const actor = createActor(commandMachine.provide({ actors: { process: powershell } }), {
    input: { timeoutMs: Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS), killGraceMs: KILL_GRACE_MS },
  });
  const cancel = (): void => {
    actor.send({ type: "command.cancel" });
  };
  signal.addEventListener("abort", cancel, { once: true });
  actor.start();
  if (signal.aborted) cancel();
  try {
    const { exit } = await toPromise(actor);
    const snapshot = actor.getSnapshot();
    const outcome = snapshot.matches("exited") ? "exited" : snapshot.matches("timedOut") ? "timedOut" : "cancelled";
    return {
      outcome,
      exitCode: exit?.exitCode ?? null,
      stdout: exit?.stdout ?? "",
      stderr: exit?.stderr ?? "",
      truncated,
      durationMs: Date.now() - started,
    };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
