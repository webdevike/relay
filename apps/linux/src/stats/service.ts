// What the omp sessions on this host cost, for the desktop's Settings > Usage. One snapshot lives
// in memory: `get()` answers it at once and a refresh runs in the background (at startup, then
// whenever a `stats.get` finds it older than STATS_STALE_MS). A refresh runs `omp stats --json` per
// profile (that syncs new transcript lines into the profile's stats.db; a cold one takes seconds),
// then reads every stats.db for 24h, 7d and 30d (read.ts).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  STATS_STALE_MS,
  type StatsPoint,
  type StatsProfile,
  type StatsRange,
  type StatsSnapshot,
} from "@relay/protocol";
import { discoverProfiles } from "../usage/usage";
import type { CaptureResult } from "../usage/service";
import { buildRange, rangeWindows, readCells, readSeries, type AgentOf, type Cell, type StatsDb } from "./read";

/** A cold sync of a large profile reads every transcript; give it room. */
export const STATS_SYNC_TIMEOUT_MS = 180_000;

/** How long after host startup the first refresh waits, so it never slows the host coming up. */
export const STATS_WARMUP_MS = 30_000;

/** One omp profile: its `--profile` name (null for the unnamed default) and its stats.db. */
export interface StatsSource {
  name: string;
  profile: string | null;
  dbPath: string;
}

export interface StatsServiceDeps {
  /** The profiles to cover, read on every refresh. */
  sources: () => StatsSource[];
  /** Runs `omp [--profile <p>] stats --json`, which syncs the profile's stats.db. */
  sync: (source: StatsSource, timeoutMs: number) => Promise<CaptureResult>;
  open: (path: string) => Promise<StatsDb>;
  /** Who ran a session; null leaves the by-agent breakdown empty. */
  agentOf?: () => Promise<AgentOf | null>;
  emit: (snapshot: StatsSnapshot) => void;
  now?: () => number;
  /** Local time offset (ms east of UTC) days are bucketed by. */
  offsetMs?: () => number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface StatsService {
  get(): StatsSnapshot;
  /** One refresh at a time; a call during one joins it. Never rejects. */
  refresh(): Promise<StatsSnapshot>;
  /** Refreshes in the background when the snapshot is missing or older than STATS_STALE_MS. */
  refreshIfStale(): void;
}

/** Why a sync gave nothing usable, from its last stderr line. */
function syncFailure(r: CaptureResult, timeoutMs: number): string {
  if (r.timedOut) return `omp stats did not finish in ${String(Math.round(timeoutMs / 1000))} s`;
  const last = r.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (last !== undefined) return last.length > 200 ? `${last.slice(0, 199)}…` : last;
  return r.code === null ? "omp stats could not start" : `omp stats exited with code ${String(r.code)}`;
}

/** Yields to the event loop between reads so a refresh never holds the host's sockets for long. */
const tick = (): Promise<undefined> => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setImmediate(() => {
    resolve(undefined);
  });
  return promise;
};

export function createStatsService(deps: StatsServiceDeps): StatsService {
  const now = deps.now ?? Date.now;
  const offsetMs = deps.offsetMs ?? (() => -new Date().getTimezoneOffset() * 60_000);
  const timeoutMs = deps.timeoutMs ?? STATS_SYNC_TIMEOUT_MS;
  let ranges: StatsSnapshot["ranges"] = null;
  let profiles: StatsProfile[] = [];
  let updatedAt: number | null = null;
  let inflight: Promise<StatsSnapshot> | null = null;

  const snapshot = (): StatsSnapshot => ({ updatedAt, refreshing: inflight !== null, profiles, ranges });

  const run = async (): Promise<void> => {
    const at = now();
    const windows = rangeWindows(at, offsetMs());
    const reads = windows.map(() => ({ cells: [] as Cell[], points: [] as StatsPoint[] }));
    const next: StatsProfile[] = [];
    for (const source of deps.sources()) {
      const r = await deps.sync(source, timeoutMs).catch(
        (e: unknown): CaptureResult => ({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false }),
      );
      // A failed sync still leaves the numbers from the last one in stats.db; show those and say so.
      let error = !r.timedOut && r.code === 0 ? null : syncFailure(r, timeoutMs);
      if (existsSync(source.dbPath)) {
        let db: StatsDb | null = null;
        try {
          db = await deps.open(source.dbPath);
          for (const [i, w] of windows.entries()) {
            reads[i]?.cells.push(...readCells(db, w.cutoff));
            await tick();
            reads[i]?.points.push(...readSeries(db, w));
            await tick();
          }
        } catch (e) {
          error = `could not read ${source.dbPath}: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          db?.close();
        }
      } else {
        error ??= `omp wrote no ${source.dbPath}`;
      }
      if (error !== null) deps.log?.(`stats: ${source.name}: ${error}`);
      next.push({ name: source.name, error });
    }
    const agentOf = (await deps.agentOf?.().catch(() => null)) ?? null;
    const built: Partial<Record<string, StatsRange>> = {};
    for (const [i, w] of windows.entries()) {
      const read = reads[i];
      if (read !== undefined) built[w.key] = buildRange(w, at, read.cells, read.points, agentOf);
    }
    const [day, week, month] = [built["24h"], built["7d"], built["30d"]];
    if (day !== undefined && week !== undefined && month !== undefined) ranges = { "24h": day, "7d": week, "30d": month };
    profiles = next;
    updatedAt = now();
  };

  const refresh = (): Promise<StatsSnapshot> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await run();
      } catch (e) {
        deps.log?.(`stats: refresh failed: ${e instanceof Error ? e.message : String(e)}`);
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
    refreshIfStale: () => {
      if (inflight === null && (updatedAt === null || now() - updatedAt > STATS_STALE_MS)) void refresh();
    },
  };
}

/** Every omp profile on this Mac: the unnamed default (~/.omp/agent) when it exists, then ~/.omp/profiles/*. */
export function ompStatsSources(home: string = homedir()): StatsSource[] {
  const root = join(home, ".omp");
  const named = discoverProfiles(join(root, "profiles")).map((p) => ({
    name: p,
    profile: p,
    dbPath: join(root, "profiles", p, "stats.db"),
  }));
  const fallback = existsSync(join(root, "agent")) ? [{ name: "default", profile: null, dbPath: join(root, "stats.db") }] : [];
  return [...fallback, ...named];
}

// A profile picked by the environment would override `--profile`'s absence for the default one.
const PROFILE_ENV = ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR"];

/** Runs `omp [--profile <p>] stats --json` from the home dir; SIGKILL at the deadline. */
export function ompStatsRunner(omp: string): StatsServiceDeps["sync"] {
  return async (source, timeoutMs) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PROFILE_ENV.includes(k)) env[k] = v;
    const args = source.profile === null ? ["stats", "--json"] : ["--profile", source.profile, "stats", "--json"];
    const proc = Bun.spawn([omp, ...args], { cwd: homedir(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const deadline = { hit: false };
    const timer = setTimeout(() => {
      deadline.hit = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code: deadline.hit ? null : code, stdout, stderr, timedOut: deadline.hit };
    } finally {
      clearTimeout(timer);
    }
  };
}

interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
    prepare(sql: string): { all(...params: number[]): unknown[] };
    close(): void;
  };
}

/**
 * Opens a stats.db read-only: bun:sqlite in the host, node:sqlite under the Node test runner. Both
 * imports are dynamic because each module exists only on its own runtime.
 */
export async function openStatsDb(path: string): Promise<StatsDb> {
  if ("bun" in process.versions) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { readonly: true });
    return {
      all: (sql, ...params) => db.query(sql).all(...params) as Record<string, unknown>[],
      close: () => {
        db.close();
      },
    };
  }
  const nodeSqlite = "node:sqlite";
  const { DatabaseSync } = (await import(nodeSqlite)) as SqliteModule;
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    close: () => {
      db.close();
    },
  };
}
