// Past runs from every omp transcript on this machine (`~/.omp/agent/sessions` and each profile's),
// cached per file by size and mtime in `~/.config/relay/eta-history.json`, so a restart only reads
// what changed. The first build reads a few GB; it yields between files and never blocks the host.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TranscriptScan, type RunRecord } from "./runs";

/** Older transcripts say little about how runs go now. */
export const HISTORY_DAYS = 120;
/** A transcript untouched this long has ended, so its last run counts as finished. */
export const QUIET_MS = 30 * 60 * 1000;
const CACHE_VERSION = 2;

interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly task: boolean;
  readonly runs: readonly RunRecord[];
}

interface CacheShape {
  readonly v: number;
  readonly files: Record<string, CachedFile>;
}

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface RefreshResult {
  /** Transcripts read this time (the rest came from the cache). */
  readonly read: number;
  readonly runs: number;
}

/** The session roots: `<omp>/agent/sessions` and `<omp>/profiles/<name>/agent/sessions`. */
export function sessionRoots(ompDir = join(homedir(), ".omp")): string[] {
  const roots = [join(ompDir, "agent", "sessions")];
  const profiles = join(ompDir, "profiles");
  if (existsSync(profiles)) for (const name of readdirSync(profiles)) roots.push(join(profiles, name, "agent", "sessions"));
  return roots.filter((root) => existsSync(root));
}

/**
 * The transcripts assistants started to do one thing: every `sessionFile` in
 * `<agentHome>/work/eva/agents/<id>/sessions.json`, open or closed.
 */
export function taskFiles(agentHome: string): Set<string> {
  const out = new Set<string>();
  const dir = join(agentHome, "work", "eva", "agents");
  let agents: string[];
  try {
    agents = readdirSync(dir);
  } catch {
    return out;
  }
  for (const agent of agents) {
    try {
      const list = JSON.parse(readFileSync(join(dir, agent, "sessions.json"), "utf8")) as unknown;
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const file = typeof entry === "object" && entry !== null && "sessionFile" in entry ? entry.sessionFile : null;
        if (typeof file === "string") out.add(file);
      }
    } catch {
      // An assistant without a sessions list starts none.
    }
  }
  return out;
}

/** Every transcript under the roots changed since `since`: top-level sessions and the helpers in each session's folder. */
export function transcripts(roots: readonly string[], since: number): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const visit = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 2) visit(path, depth + 1);
      } else if (name.endsWith(".jsonl") && stat.mtimeMs >= since) {
        out.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return out;
}

/** The finished runs in one transcript's text. A transcript still being written keeps its last run open (left out). */
export function runsOf(path: string, text: string, quiet: boolean, task = false): readonly RunRecord[] {
  const scan = new TranscriptScan(path, task);
  for (const line of text.split("\n")) scan.line(line);
  return quiet ? scan.finish() : scan.runs();
}

export class RunHistory {
  private cache: Record<string, CachedFile> = {};

  constructor(
    private readonly cachePath: string,
    private readonly roots: readonly string[],
    /** Transcripts that are assistant-started tasks (`taskFiles`). */
    private readonly tasks: () => ReadonlySet<string>,
    private readonly log: (line: string) => void = () => {},
  ) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as CacheShape;
      if (parsed.v === CACHE_VERSION) this.cache = parsed.files;
    } catch {
      // No cache yet, or an old one: build afresh.
    }
  }

  /** Every finished run known, oldest first. */
  runs(): RunRecord[] {
    return Object.values(this.cache)
      .flatMap((file) => file.runs)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Reads the transcripts that changed since the cache was written, then saves the cache.
   * `pause` runs between files (the host passes a yield so serving never waits on this).
   */
  async refresh(now: number, pause: () => Promise<void> = async () => {}): Promise<RefreshResult> {
    const since = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const found = transcripts(this.roots, since);
    const tasks = this.tasks();
    const next: Record<string, CachedFile> = {};
    let read = 0;
    for (const file of found) {
      const task = tasks.has(file.path);
      const cached = this.cache[file.path];
      if (cached !== undefined && cached.size === file.size && cached.mtimeMs === file.mtimeMs && cached.task === task) {
        next[file.path] = cached;
        continue;
      }
      try {
        const text = await readFile(file.path, "utf8");
        next[file.path] = { size: file.size, mtimeMs: file.mtimeMs, task, runs: runsOf(file.path, text, now - file.mtimeMs > QUIET_MS, task) };
        read += 1;
      } catch (error) {
        this.log(`eta: could not read ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await pause();
    }
    this.cache = next;
    if (read > 0) this.save();
    return { read, runs: Object.values(next).reduce((sum, file) => sum + file.runs.length, 0) };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files: this.cache } satisfies CacheShape));
      renameSync(tmp, this.cachePath);
    } catch (error) {
      this.log(`eta: could not save the history cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
