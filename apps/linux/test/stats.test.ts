import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATS_STALE_MS, StatsSnapshot } from "@relay/protocol";
import { createStatsService, openStatsDb, type StatsSource } from "../src/stats/service";
import type { CaptureResult } from "../src/usage/service";

// node:sqlite is newer than the @types/node this package pins, so its shape is declared here.
interface WritableDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: (string | number | null)[]): void };
  close(): void;
}
const nodeSqlite = "node:sqlite";
const { DatabaseSync } = (await import(nodeSqlite)) as { DatabaseSync: new (path: string) => WritableDb };

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// 2026-11-06 15:30 UTC, 09:30 in Chicago (UTC-6).
const NOW = Date.UTC(2026, 10, 6, 15, 30);
const OFFSET = -6 * HOUR;

// omp's messages table (packages/stats), the columns the host reads.
const SCHEMA = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL, entry_id TEXT NOT NULL, folder TEXT NOT NULL,
  model TEXT NOT NULL, provider TEXT NOT NULL, api TEXT NOT NULL, timestamp INTEGER NOT NULL, duration INTEGER, ttft INTEGER,
  stop_reason TEXT NOT NULL, error_message TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
  premium_requests REAL NOT NULL, cost_input REAL NOT NULL, cost_output REAL NOT NULL, cost_cache_read REAL NOT NULL,
  cost_cache_write REAL NOT NULL, cost_total REAL NOT NULL, cost_no_cache_input REAL, cost_unpriced INTEGER NOT NULL DEFAULT 0,
  agent_type TEXT NOT NULL DEFAULT 'main', service_tier TEXT, UNIQUE(session_file, entry_id))`;

interface Row {
  session: string;
  folder?: string;
  model?: string;
  provider?: string;
  at: number;
  error?: boolean;
  cost?: number;
  ttft?: number | null;
  duration?: number | null;
  output?: number;
  input?: number;
  cacheRead?: number;
  noCache?: number | null;
  promptCost?: number;
  unpriced?: boolean;
  agentType?: "main" | "subagent";
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function statsDb(rows: Row[]): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-stats-"));
  dirs.push(dir);
  const path = join(dir, "stats.db");
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft,
    stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input,
    cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type)
    VALUES (?, ?, ?, ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?)`);
  rows.forEach((r, i) => {
    const input = r.input ?? 10;
    const output = r.output ?? 100;
    const cacheRead = r.cacheRead ?? 0;
    insert.run(
      r.session,
      `e${String(i)}`,
      r.folder ?? "-Eva",
      r.model ?? "claude-opus-5-5",
      r.provider ?? "anthropic",
      r.at,
      r.duration ?? null,
      r.ttft ?? null,
      r.error === true ? "error" : "stop",
      input,
      output,
      cacheRead,
      input + output + cacheRead,
      r.promptCost ?? 0,
      r.cost ?? 0,
      r.noCache ?? null,
      r.unpriced === true ? 1 : 0,
      r.agentType ?? "main",
    );
  });
  db.close();
  return path;
}

const ok: CaptureResult = { code: 0, stdout: "{}", stderr: "", timedOut: false };

function service(sources: StatsSource[], o: { sync?: (s: StatsSource) => Promise<CaptureResult>; now?: () => number; agents?: Record<string, string> } = {}) {
  const emitted: StatsSnapshot[] = [];
  const synced: string[] = [];
  const s = createStatsService({
    sources: () => sources,
    sync: (source) => {
      synced.push(source.name);
      return o.sync?.(source) ?? Promise.resolve(ok);
    },
    open: openStatsDb,
    // With no agents given, the service has no way to attribute sessions at all.
    agentOf: () => {
      const agents = o.agents;
      if (agents === undefined) return Promise.resolve(null);
      return Promise.resolve((file: string) => {
        const label = agents[file];
        return label === undefined ? null : { agent: label.toLowerCase(), label };
      });
    },
    emit: (snap) => {
      emitted.push(StatsSnapshot.parse(snap));
    },
    now: o.now ?? (() => NOW),
    offsetMs: () => OFFSET,
  });
  return { s, emitted, synced };
}

describe("stats from omp's stats.db", () => {
  it("sums each range from the requests inside it: cost, failures, cache savings, speed, by model, folder and main/subagent", async () => {
    const path = statsDb([
      // ttft and tokens/s average over the requests that report them; savings = no-cache prompt cost minus the real one.
      { session: "/s/a.jsonl", folder: "-Eva-work-relay", at: NOW - HOUR, cost: 2, ttft: 1000, duration: 2000, output: 100, noCache: 5, promptCost: 1 },
      { session: "/s/a.jsonl", folder: "-Eva-work-relay", at: NOW - 2 * HOUR, cost: 1, ttft: 3000, error: true },
      { session: "/s/a.jsonl", folder: "-Eva-work-relay", at: NOW - 5 * HOUR, unpriced: true },
      { session: "/s/b.jsonl", model: "gpt-5.5", provider: "openai-codex", at: NOW - 3 * DAY, cost: 0.5, agentType: "subagent" },
      { session: "/s/b.jsonl", model: "gpt-5.5", provider: "openai-codex", at: NOW - 40 * DAY, cost: 99 },
    ]);
    const { s } = service([{ name: "personal", profile: "personal", dbPath: path }]);
    const snap = await s.refresh();
    expect(snap.profiles).toEqual([{ name: "personal", error: null }]);
    const day = snap.ranges?.["24h"];
    expect(day?.totals).toEqual({
      requests: 3,
      failed: 1,
      costUsd: 3,
      unpriced: 1,
      inputTokens: 30,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheSavingsUsd: 4,
      avgTtftMs: 2000,
      tokensPerSecond: 50,
    });
    expect(day?.byFolder.map((f) => f.folder)).toEqual(["-Eva-work-relay"]);

    const week = snap.ranges?.["7d"];
    expect(week?.totals.requests).toBe(4);
    expect(week?.byModel.map((m) => [m.model, m.costUsd, m.requests])).toEqual([
      ["claude-opus-5-5", 3, 3],
      ["gpt-5.5", 0.5, 1],
    ]);
    expect(week?.byAgentType.map((t) => [t.type, t.requests])).toEqual([
      ["main", 3],
      ["subagent", 1],
    ]);
    // Nothing older than 30 days.
    expect(snap.ranges?.["30d"].totals.costUsd).toBe(3.5);
    // No attribution: no by-agent rows rather than a guess.
    expect(week?.byAgent).toEqual([]);
  });

  it("buckets the series by the hour for 24h and by local day for 7d and 30d, every bucket present", async () => {
    const path = statsDb([
      { session: "/s/a.jsonl", at: NOW - 10 * 60_000, cost: 1 },
      // 2026-11-03 23:30 in Chicago: still Nov 3 locally, Nov 4 in UTC.
      { session: "/s/a.jsonl", at: Date.UTC(2026, 10, 4, 5, 30), cost: 2, error: true },
    ]);
    const snap = await service([{ name: "personal", profile: "personal", dbPath: path }]).s.refresh();
    const hours = snap.ranges?.["24h"].series ?? [];
    // A rolling 24 hours: the first hour is partial, so 25 buckets from 15:00 yesterday.
    expect(hours).toHaveLength(25);
    expect(hours[0]?.at).toBe(Date.UTC(2026, 10, 5, 15));
    expect(hours.at(-1)).toMatchObject({ at: Date.UTC(2026, 10, 6, 15), requests: 1, costUsd: 1 });
    const days = snap.ranges?.["7d"].series ?? [];
    // Local midnight in Chicago is 06:00 UTC; the range starts six days before today.
    const localMidnight = (d: number): number => Date.UTC(2026, 10, d, 6);
    expect(days.map((p) => p.at)).toEqual(Array.from({ length: 7 }, (_, i) => Date.UTC(2026, 9, 31, 6) + i * DAY));
    expect(days.find((p) => p.at === localMidnight(3))).toMatchObject({ requests: 1, failed: 1, costUsd: 2 });
    expect(days.at(-1)).toMatchObject({ at: localMidnight(6), requests: 1 });
    expect(snap.ranges?.["30d"].series).toHaveLength(30);
  });

  it("merges every profile and groups requests by who ran the session", async () => {
    const personal = statsDb([{ session: "/p/nova.jsonl", at: NOW - HOUR, cost: 4 }]);
    const work = statsDb([
      { session: "/w/astra.jsonl", at: NOW - HOUR, cost: 1 },
      { session: "/w/unknown.jsonl", at: NOW - HOUR, cost: 7 },
    ]);
    const { s, synced } = service(
      [
        { name: "personal", profile: "personal", dbPath: personal },
        { name: "work", profile: "work", dbPath: work },
      ],
      { agents: { "/p/nova.jsonl": "Nova", "/w/astra.jsonl": "Astra" } },
    );
    const snap = await s.refresh();
    expect(synced).toEqual(["personal", "work"]);
    expect(snap.ranges?.["24h"].totals.costUsd).toBe(12);
    expect(snap.ranges?.["24h"].byAgent.map((a) => [a.label, a.costUsd])).toEqual([
      ["Nova", 4],
      ["Astra", 1],
    ]);
  });
});

describe("stats service", () => {
  it("answers from memory while one background refresh runs, and refreshes again only once stale", async () => {
    const path = statsDb([{ session: "/s/a.jsonl", at: NOW - HOUR, cost: 1 }]);
    let now = NOW;
    let release: (r: CaptureResult) => void = () => undefined;
    const { s, emitted, synced } = service([{ name: "personal", profile: "personal", dbPath: path }], {
      now: () => now,
      sync: () => {
        const { promise, resolve } = Promise.withResolvers<CaptureResult>();
        release = resolve;
        return promise;
      },
    });
    expect(s.get()).toEqual({ updatedAt: null, refreshing: false, profiles: [], ranges: null });
    s.refreshIfStale();
    const joined = s.refresh();
    expect(s.get().refreshing).toBe(true);
    expect(emitted.map((e) => e.refreshing)).toEqual([true]);
    release(ok);
    const done = await joined;
    expect(synced).toEqual(["personal"]);
    expect(done.refreshing).toBe(false);
    expect(done.ranges?.["24h"].totals.costUsd).toBe(1);
    expect(emitted.map((e) => e.refreshing)).toEqual([true, false]);

    now += STATS_STALE_MS - 1;
    s.refreshIfStale();
    expect(s.get().refreshing).toBe(false);
    now += 2;
    s.refreshIfStale();
    expect(s.get().refreshing).toBe(true);
  });

  it("keeps showing the last synced numbers when omp stats fails, and says why per profile", async () => {
    const path = statsDb([{ session: "/s/a.jsonl", at: NOW - HOUR, cost: 1 }]);
    const { s } = service(
      [
        { name: "personal", profile: "personal", dbPath: path },
        { name: "work", profile: "work", dbPath: join(tmpdir(), "relay-stats-missing", "stats.db") },
      ],
      { sync: (src) => Promise.resolve(src.name === "personal" ? { code: 1, stdout: "", stderr: "boom\nError: locked\n", timedOut: false } : ok) },
    );
    const snap = await s.refresh();
    expect(snap.ranges?.["24h"].totals.costUsd).toBe(1);
    expect(snap.profiles).toEqual([
      { name: "personal", error: "Error: locked" },
      { name: "work", error: `omp wrote no ${join(tmpdir(), "relay-stats-missing", "stats.db")}` },
    ]);
  });
});
