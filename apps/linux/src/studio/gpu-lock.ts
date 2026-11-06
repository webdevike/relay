// The machine-wide GPU lock: `~/.cache/eva-gpu.lock` (`$EVA_GPU_LOCK`), the file draft.py (LTX) and moss.py
// (MOSS-Image) hold with flock(2) for their whole run, so one heavy GPU job runs on this Mac at a time whoever
// starts it (Studio, overnight loops, agents). Studio takes it itself around the local GPU work that has no
// script of its own to take it: Kontext, ComfyUI presets on this Mac, SAM 2.1 (cutouts and segment runs).
//
// Node has no flock, so a tiny Perl process (macOS and Linux ship it; its `flock` is flock(2), the same lock as
// Python's `fcntl.flock`) opens the file, tries LOCK_NB first and says `waiting` when someone else holds it, then
// blocks, writes the holder line like the scripts do and says `acquired`. It holds the lock until the host closes
// its stdin or it is killed; when the host dies its stdin closes, so the lock never outlives the host.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface GpuLockRequest {
  /** The holder line written into the lock file ("pid 123 (relay studio kontext) since ..."). */
  readonly holder: string;
  /** Aborting while waiting gives up the wait (the acquire rejects with "Cancelled"). */
  readonly signal: AbortSignal;
  /** Another process holds the lock and this waits (true), then got it (false). Not called when it was free. */
  readonly waiting: (waiting: boolean) => void;
}

export interface GpuLock {
  /** Resolves once the lock is held, with its release (resolves when the lock is free again). */
  acquire(request: GpuLockRequest): Promise<() => Promise<void>>;
}

export function defaultGpuLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["EVA_GPU_LOCK"] ?? join(homedir(), ".cache", "eva-gpu.lock");
}

/** "pid 123 (relay studio kontext) since 2026-11-06 21:04:05", like draft.py's and moss.py's holder lines. */
export function gpuLockHolder(what: string, now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `pid ${String(process.pid)} (relay studio ${what}) since ${stamp}`;
}

const HELPER = String.raw`
use strict;
use warnings;
use Fcntl qw(:flock O_RDWR O_CREAT);
$| = 1;
my ($path, $holder) = @ARGV;
sysopen(my $fh, $path, O_RDWR | O_CREAT, 0644) or die "cannot open $path: $!\n";
unless (flock($fh, LOCK_EX | LOCK_NB)) {
  print "waiting\n";
  flock($fh, LOCK_EX) or die "cannot lock $path: $!\n";
}
truncate($fh, 0);
syswrite($fh, $holder);
print "acquired\n";
my $buffer;
1 while sysread(STDIN, $buffer, 4096);
`;

export class FlockGpuLock implements GpuLock {
  constructor(
    private readonly path: string = defaultGpuLockPath(),
    private readonly perl = "/usr/bin/perl",
  ) {}

  acquire(request: GpuLockRequest): Promise<() => Promise<void>> {
    const { promise, resolve, reject } = Promise.withResolvers<() => Promise<void>>();
    if (request.signal.aborted) {
      reject(new Error("Cancelled"));
      return promise;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const child = spawn(this.perl, ["-e", HELPER, this.path, request.holder], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>((done) => {
      child.once("close", () => {
        done();
      });
    });
    let held = false;
    let waited = false;
    let stdout = "";
    let stderr = "";
    const release = async (): Promise<void> => {
      child.stdin.end();
      child.kill("SIGTERM");
      await exited;
    };
    const onAbort = (): void => {
      child.kill("SIGKILL");
      reject(new Error("Cancelled"));
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "waiting") {
          waited = true;
          request.waiting(true);
        } else if (line === "acquired" && !held) {
          held = true;
          request.signal.removeEventListener("abort", onAbort);
          if (waited) request.waiting(false);
          resolve(release);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => {
      request.signal.removeEventListener("abort", onAbort);
      reject(new Error(`Could not take the GPU lock: ${error.message}`));
    });
    child.on("close", (code) => {
      request.signal.removeEventListener("abort", onAbort);
      if (!held) reject(new Error(`Could not take the GPU lock ${this.path}: ${stderr.trim() || `exit ${String(code)}`}`));
    });
    return promise;
  }
}
