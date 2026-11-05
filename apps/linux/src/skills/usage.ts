// When skills were last loaded, from omp's own session logs: a load is a `"path":"skill://<name>`
// in a transcript line (a read of the skill), timed by that line's `"timestamp":"..."`. Transcripts
// are `~/.omp/profiles/<profile>/agent/sessions/**/*.jsonl` and `~/.omp/agent/sessions/**/*.jsonl`
// (omp's default profile); only files modified in the last 30 days are read. Over a gigabyte in all,
// so files are streamed in chunks and searched as bytes, each file's loads cached by size and mtime,
// and the scan runs in the background at most every 10 minutes: readers get the last snapshot.

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_NAME } from "./types";

export const USAGE_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const USAGE_REFRESH_MS = 10 * 60_000;
const CHUNK = 1 << 20;
const NEEDLE = Buffer.from('"path":"skill://');
const STAMP = Buffer.from('"timestamp":"');
const NEWLINE = 0x0a;
const NAME_END = new Set([0x2f, 0x22, 0x3f, 0x23, 0x5c]); // / " ? # \

/** One skill's loads in the window. */
export interface SkillUsage {
  loads: number;
  lastUsedAt: number | null;
  /** The profile of the newest load (null: omp's default profile). */
  lastProfile: string | null;
}

interface Load {
  name: string;
  at: number;
}

interface CachedFile {
  size: number;
  mtimeMs: number;
  loads: Load[];
}

export interface UsageDeps {
  readonly home: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** The loads in one transcript, read in chunks; a line without a timestamp gets `fallbackAt`. */
export async function scanTranscript(path: string, fallbackAt: number): Promise<Load[]> {
  const loads: Load[] = [];
  const handle = await open(path, "r");
  try {
    let carry: Buffer = Buffer.alloc(0);
    const chunk = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, null);
      const data = carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      // At EOF the remainder is the last line; otherwise only whole lines are searched.
      const end = bytesRead === 0 ? data.length : data.lastIndexOf(NEWLINE) + 1;
      collect(data.subarray(0, end), fallbackAt, loads);
      if (bytesRead === 0) break;
      carry = Buffer.from(data.subarray(end));
    }
  } finally {
    await handle.close();
  }
  return loads;
}

/** Appends the loads in `data` (whole lines) to `out`. */
function collect(data: Buffer, fallbackAt: number, out: Load[]): void {
  let from = 0;
  for (;;) {
    const hit = data.indexOf(NEEDLE, from);
    if (hit < 0) return;
    let end = hit + NEEDLE.length;
    while (end < data.length && !NAME_END.has(data[end] ?? 0x22) && data[end] !== NEWLINE) end += 1;
    from = end;
    const name = data.toString("utf8", hit + NEEDLE.length, end);
    if (!SKILL_NAME.test(name)) continue;
    const lineStart = data.lastIndexOf(NEWLINE, hit) + 1;
    let lineEnd = data.indexOf(NEWLINE, hit);
    if (lineEnd < 0) lineEnd = data.length;
    const stamp = data.indexOf(STAMP, lineStart);
    let at = fallbackAt;
    if (stamp >= 0 && stamp < lineEnd) {
      const close = data.indexOf(0x22, stamp + STAMP.length);
      const parsed = close < 0 || close > lineEnd ? Number.NaN : Date.parse(data.toString("utf8", stamp + STAMP.length, close));
      if (!Number.isNaN(parsed)) at = parsed;
    }
    out.push({ name, at });
  }
}

export class SkillUsageIndex {
  private readonly files = new Map<string, CachedFile & { profile: string | null }>();
  private snapshotByName = new Map<string, SkillUsage>();
  private running: Promise<void> | null = null;
  private startedAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: UsageDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The last snapshot (empty before the first scan finished); starts a background scan when due. */
  usage(name: string): SkillUsage {
    this.refreshIfDue();
    return this.snapshotByName.get(name) ?? { loads: 0, lastUsedAt: null, lastProfile: null };
  }

  /** Starts a background scan unless one runs or the last started under `USAGE_REFRESH_MS` ago. */
  refreshIfDue(): void {
    if (this.running !== null) return;
    if (this.startedAt !== null && this.now() - this.startedAt < USAGE_REFRESH_MS) return;
    void this.refresh();
  }

  /** Scans now (or joins the running scan). */
  refresh(): Promise<void> {
    if (this.running !== null) return this.running;
    this.startedAt = this.now();
    this.running = this.scan()
      .catch((error: unknown) => {
        this.deps.log?.(`skills usage scan failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async scan(): Promise<void> {
    const now = this.now();
    const since = now - USAGE_WINDOW_MS;
    const roots: { dir: string; profile: string | null }[] = [{ dir: join(this.deps.home, ".omp", "agent", "sessions"), profile: null }];
    const profilesDir = join(this.deps.home, ".omp", "profiles");
    for (const profile of await readdir(profilesDir).catch(() => [] as string[])) {
      if (!profile.startsWith(".")) roots.push({ dir: join(profilesDir, profile, "agent", "sessions"), profile });
    }
    const seen = new Set<string>();
    for (const root of roots) {
      const entries = await readdir(root.dir, { recursive: true }).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const path = join(root.dir, entry);
        const stats = await stat(path).catch(() => null);
        if (stats === null || !stats.isFile() || stats.mtimeMs < since) continue;
        seen.add(path);
        const cached = this.files.get(path);
        if (cached?.size === stats.size && cached.mtimeMs === stats.mtimeMs) continue;
        const loads = await scanTranscript(path, stats.mtimeMs).catch(() => null);
        if (loads !== null) this.files.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, loads, profile: root.profile });
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    const next = new Map<string, SkillUsage>();
    for (const file of this.files.values()) {
      for (const load of file.loads) {
        if (load.at < since) continue;
        const usage = next.get(load.name) ?? { loads: 0, lastUsedAt: null, lastProfile: null };
        usage.loads += 1;
        if (usage.lastUsedAt === null || load.at > usage.lastUsedAt) {
          usage.lastUsedAt = load.at;
          usage.lastProfile = file.profile;
        }
        next.set(load.name, usage);
      }
    }
    this.snapshotByName = next;
  }
}
