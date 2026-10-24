// Plan usage of every omp account on this host: runs `omp --profile <p> usage --json` per profile
// under ~/.omp/profiles. Ported from Relay desktop's usage-service.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { USAGE_PROVIDERS, type UsageAccount, type UsageSnapshot } from "@relay/protocol";
import { discoverProfiles, failureReason, mergeProfile, parseUsageOutput } from "./usage";

export const USAGE_POLL_MS = 5 * 60_000;
export const USAGE_FOCUS_MIN_MS = 60_000;
export const USAGE_TIMEOUT_MS = 20_000;

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface UsageServiceDeps {
  profilesDir: string;
  /** Runs `omp --profile <profile> usage --json` with the given deadline. */
  run: (profile: string, timeoutMs: number) => Promise<CaptureResult>;
  emit: (snapshot: UsageSnapshot) => void;
  now?: () => number;
  timeoutMs?: number;
}

export interface UsageService {
  get(): UsageSnapshot;
  /** One refresh at a time; a call during one joins it. Never rejects. */
  refresh(): Promise<UsageSnapshot>;
  /** Refreshes when the last one finished more than a minute ago. */
  refreshIfOld(): void;
}

/** Accounts for every profile under `profilesDir` (read on each refresh), provider-major order. */
export function createUsageService(deps: UsageServiceDeps): UsageService {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? USAGE_TIMEOUT_MS;
  let accounts: UsageAccount[] = [];
  let updatedAt: number | null = null;
  let inflight: Promise<UsageSnapshot> | null = null;

  const snapshot = (): UsageSnapshot => ({ accounts, updatedAt, refreshing: inflight !== null });

  const fetchProfile = async (profile: string, previous: readonly UsageAccount[]): Promise<UsageAccount[]> => {
    const r = await deps.run(profile, timeoutMs).catch(
      (e: unknown): CaptureResult => ({
        code: null,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
      }),
    );
    const usage = !r.timedOut && r.code === 0 ? parseUsageOutput(r.stdout) : null;
    if (usage) return mergeProfile(previous, profile, { ok: true, usage });
    const reason =
      !r.timedOut && r.code === 0 ? "omp usage printed output Relay could not read" : failureReason(r, timeoutMs);
    return mergeProfile(previous, profile, { ok: false, reason });
  };

  const refresh = (): Promise<UsageSnapshot> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const previous = accounts;
        const profiles = discoverProfiles(deps.profilesDir);
        const perProfile = (await Promise.all(profiles.map((p) => fetchProfile(p, previous)))).flat();
        // Provider-major: Claude for each profile, then Codex for each profile.
        accounts = USAGE_PROVIDERS.flatMap((p) => perProfile.filter((a) => a.provider === p));
        updatedAt = now();
      } finally {
        inflight = null;
      }
      const done = snapshot();
      deps.emit(done);
      return done;
    })();
    deps.emit(snapshot());
    return inflight;
  };

  return {
    get: snapshot,
    refresh,
    refreshIfOld: () => {
      if (updatedAt === null || now() - updatedAt > USAGE_FOCUS_MIN_MS) void refresh();
    },
  };
}

/** The omp binary: on PATH, else `~/.local/bin/omp` (launchd gives the host a bare PATH). */
export function resolveOmp(): string {
  const onPath = Bun.which("omp");
  if (onPath !== null) return onPath;
  const local = join(homedir(), ".local", "bin", "omp");
  return existsSync(local) ? local : "omp";
}

/** Runs `omp --profile <profile> usage --json` from the home dir; SIGKILL at the deadline. */
export function ompUsageRunner(omp: string = resolveOmp()): UsageServiceDeps["run"] {
  return async (profile, timeoutMs) => {
    const proc = Bun.spawn([omp, "--profile", profile, "usage", "--json"], {
      cwd: homedir(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = { hit: false };
    const timer = setTimeout(() => {
      deadline.hit = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code: deadline.hit ? null : code, stdout, stderr, timedOut: deadline.hit };
    } finally {
      clearTimeout(timer);
    }
  };
}
