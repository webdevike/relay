// Local LTX video on the Mac's GPU: `work/local-video/draft.py` in its own venv, which runs
// `ltx-2-mlx generate` and then ffmpeg (so ffmpeg must be on PATH: launchd gives the host a bare
// one, hence Homebrew's dirs first). draft.py starts children, so it runs in its own process
// group and a cancel signals the whole group: SIGTERM, then SIGKILL after a grace period.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { StudioBackend } from "@relay/protocol";
import { BACKEND_BASE } from "./backends";
import type { StudioRunInput, StudioRunner, StudioRunOutput } from "./runner";

/** How long a cancelled job's processes get to exit on SIGTERM before SIGKILL. */
export const LTX_KILL_GRACE_MS = 5000;
/** Where a mid keyframe sits in the clip. */
const MID_AT = 0.5;
const PATH_PREFIX = "/opt/homebrew/bin:/usr/local/bin";

/** draft.py's argv for one job, writing the clip to `out`. */
export function ltxArgv(
  python: string,
  script: string,
  input: Pick<StudioRunInput, "spec" | "seed" | "frames">,
  out: string,
): [string, ...string[]] {
  const { spec, seed, frames } = input;
  const argv: [string, ...string[]] = [python, script, "--prompt", spec.prompt, "--seconds", String(spec.seconds ?? 5), "--res", spec.resolution];
  if (seed !== undefined) argv.push("--seed", String(seed));
  argv.push("--out", out);
  if (frames.start !== undefined && frames.end !== undefined) argv.push("--start", frames.start, "--end", frames.end);
  if (frames.mid !== undefined) argv.push("--mid", `${frames.mid}@${String(MID_AT)}`);
  return argv;
}

export interface GroupRunOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  /** SIGTERM to SIGKILL on abort. */
  readonly graceMs: number;
}

/**
 * Runs `argv` as the leader of a new process group. Resolves on exit 0; rejects with the last
 * lines of stderr otherwise, and with "Cancelled" once `signal` aborts (after which the whole
 * group gets SIGTERM, then SIGKILL `graceMs` later if any of it is left).
 */
export function runProcessGroup(argv: readonly [string, ...string[]], options: GroupRunOptions): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  if (options.signal.aborted) {
    reject(new Error("Cancelled"));
    return promise;
  }
  const [file, ...args] = argv;
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-8192);
  });
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false; // The group is gone.
    }
  };
  let stopKill: (() => void) | null = null;
  const onAbort = (): void => {
    signalGroup("SIGTERM");
    const timer = setTimeout(() => {
      signalGroup("SIGKILL");
    }, options.graceMs);
    stopKill = () => {
      clearTimeout(timer);
    };
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  child.on("error", (error) => {
    options.signal.removeEventListener("abort", onAbort);
    reject(new Error(`${basename(file)}: ${error.message}`));
  });
  child.on("close", (code, signal) => {
    options.signal.removeEventListener("abort", onAbort);
    // Stop waiting to SIGKILL once nothing in the group is left (signal 0 only checks).
    if (!signalGroup(0)) stopKill?.();
    if (options.signal.aborted) reject(new Error("Cancelled"));
    else if (code === 0) resolve(undefined);
    else reject(new Error(stderrTail(tail) || `${basename(file)} exited with ${code === null ? (signal ?? "a signal") : String(code)}`));
  });
  return promise;
}

/** The last few non-blank stderr lines (progress bars redraw with `\r`), joined into one. */
function stderrTail(text: string): string {
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-3)
    .join(" | ");
}

export class LtxRunner implements StudioRunner {
  private readonly python: string;
  private readonly script: string;

  /** `dir` is `work/local-video`: draft.py next to its `.venv`. */
  constructor(
    private readonly dir: string,
    private readonly graceMs = LTX_KILL_GRACE_MS,
  ) {
    this.python = join(dir, ".venv", "bin", "python");
    this.script = join(dir, "draft.py");
  }

  describe(): Promise<StudioBackend> {
    const missing = [this.script, this.python].find((path) => !existsSync(path));
    return Promise.resolve(
      missing === undefined
        ? { ...BACKEND_BASE.ltx, available: true }
        : { ...BACKEND_BASE.ltx, available: false, reason: `LTX is not set up on this host (no ${missing})` },
    );
  }

  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    const out = join(input.workDir, "out.mp4");
    await runProcessGroup(ltxArgv(this.python, this.script, input, out), {
      cwd: this.dir,
      env: { ...process.env, PATH: `${PATH_PREFIX}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
      signal: input.signal,
      graceMs: this.graceMs,
    });
    if (!existsSync(out)) throw new Error("LTX finished without writing a video");
    return { path: out, mimeType: "video/mp4" };
  }
}
