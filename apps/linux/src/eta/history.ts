// Past runs from every omp transcript on this machine (`~/.omp/agent/sessions` and each profile's),
// cached per file by size and mtime in `~/.config/relay/eta-history.json`, so a restart only reads
// what changed. The first build reads a few GB; it yields between files and never blocks the host.
//
// Helpers (subagents) live beside their parent's transcript (`<session>/<Name>.jsonl`, a lane's own
// helpers one folder deeper); who ran each comes from the parent's `task` call. An Eva agent session
// (`<agentHome>/work/eva/agent-sessions/*.json`) is one task across its rotated transcripts, with the
// `--max-time` it may run for: its transcripts' runs are merged into that one run.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { classifyKind, TranscriptScan, type RunRecord } from "./runs";

/** Older transcripts say little about how runs go now. */
export const HISTORY_DAYS = 120;
/** A transcript untouched this long has ended, so its last run counts as finished. */
export const QUIET_MS = 30 * 60 * 1000;
const CACHE_VERSION = 3;

interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly task: boolean;
  /** A helper's parent transcript and its name in the parent's `task` call. */
  readonly parent: string | null;
  readonly name: string | null;
  /** Helpers this transcript started: name to agent definition. */
  readonly spawns: Readonly<Record<string, string>>;
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

/** One `agent-session.ts start` run: a task with a time limit, possibly over several rotated transcripts. */
export interface AgentSession {
  readonly title: string;
  /** Its `--agent` (helper definition), null for the default agent. */
  readonly role: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly startedAt: number;
  /** Null while it runs. */
  readonly endedAt: number | null;
  /** `done` and `timeout` ran their course; `failed` and `stopped` were cut short. */
  readonly state: string;
  /** `--max-time`: the supervisor stops it this long after `startedAt`. */
  readonly limitMs: number;
  /** The HANDOFF file it keeps its plan in. */
  readonly handoff: string | null;
  /** Its transcripts, oldest first. */
  readonly files: readonly string[];
}

/** What the agent home says about which transcripts are tasks. */
export interface SessionSources {
  /** Transcripts assistants started (`taskFiles`). */
  readonly tasks: ReadonlySet<string>;
  readonly agentSessions: readonly AgentSession[];
}

export const NO_SOURCES: SessionSources = { tasks: new Set(), agentSessions: [] };

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

const Instant = z.string().transform((value, ctx) => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) ctx.addIssue({ code: "custom", message: "not a date" });
  return ms;
});
const AgentSessionFile = z.object({
  title: z.string(),
  agent: z.string().min(1).nullish(),
  model: z.string().nullish(),
  thinking: z.string().nullish(),
  startedAt: Instant,
  endedAt: Instant.nullish(),
  state: z.string(),
  maxMs: z.number().positive(),
  handoff: z.string().nullish(),
  sessionFile: z.string().nullish(),
  sessionFiles: z.array(z.string()).catch([]),
});

/** Every agent session `<agentHome>/work/eva/agent-sessions/*.json` records (Eva's `.omp/tools/agent-session.ts`). */
export function agentSessions(agentHome: string): AgentSession[] {
  const dir = join(agentHome, "work", "eva", "agent-sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: AgentSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let parsed;
    try {
      parsed = AgentSessionFile.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    const run = parsed.data;
    const files = run.sessionFiles.length > 0 ? run.sessionFiles : run.sessionFile ? [run.sessionFile] : [];
    if (files.length === 0) continue;
    out.push({
      title: run.title,
      role: run.agent ?? null,
      model: run.model ?? null,
      thinking: run.thinking ?? null,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      state: run.state,
      limitMs: run.maxMs,
      handoff: run.handoff ?? null,
      files,
    });
  }
  return out;
}

/** Tasks and agent sessions under an agent home; none without one. */
export function sessionSources(agentHome: string | null): SessionSources {
  return agentHome === null ? NO_SOURCES : { tasks: taskFiles(agentHome), agentSessions: agentSessions(agentHome) };
}

/** Every transcript under the roots changed since `since`: top-level sessions, their helpers, and the helpers' own helpers. */
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
        if (depth < 3) visit(path, depth + 1);
      } else if (name.endsWith(".jsonl") && stat.mtimeMs >= since) {
        out.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return out;
}

/** One transcript's text, scanned. A transcript still being written keeps its last run open (left out of `runs`). */
export function scanTranscript(path: string, text: string, quiet: boolean, task = false): TranscriptScan {
  const scan = new TranscriptScan(path, task);
  for (const line of text.split("\n")) scan.line(line);
  if (quiet) scan.finish();
  return scan;
}

/**
 * An agent session's transcripts' runs as the one task it was: from its start to its end, turns and
 * plan steps shifted onto its clock. Null while it runs.
 */
export function mergeSession(session: AgentSession, runs: readonly RunRecord[]): RunRecord | null {
  if (session.endedAt === null || session.endedAt <= session.startedAt) return null;
  const turnAt: number[] = [];
  const stepsAt: [number, number, number][] = [];
  let outputTokens = 0;
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    const offset = Math.max(0, Math.round((run.startedAt - session.startedAt) / 1000));
    for (const at of run.turnAt) turnAt.push(offset + at);
    for (const [at, done, total] of run.stepsAt) stepsAt.push([offset + at, done, total]);
    outputTokens += run.outputTokens;
  }
  return {
    agent: "task",
    role: session.role,
    kind: classifyKind(session.title),
    model: runs.at(-1)?.model ?? session.model,
    thinking: session.thinking,
    file: session.files.at(-1)!,
    title: session.title,
    startedAt: session.startedAt,
    durationMs: session.endedAt - session.startedAt,
    // A timeout ran the whole limit: that is how long it took.
    outcome: session.state === "done" || session.state === "timeout" ? "done" : "failed",
    turnAt,
    outputTokens,
    stepsAt,
    limitMs: session.limitMs,
  };
}

export class RunHistory {
  private cache: Record<string, CachedFile> = {};
  private sessions: readonly AgentSession[] = [];

  constructor(
    private readonly cachePath: string,
    private readonly roots: readonly string[],
    /** Which transcripts are tasks (`sessionSources`). */
    private readonly sources: () => SessionSources,
    private readonly log: (line: string) => void = () => {},
  ) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as CacheShape;
      if (parsed.v === CACHE_VERSION) this.cache = parsed.files;
    } catch {
      // No cache yet, or an old one: build afresh.
    }
  }

  /** The agent definition a parent's `task` call gave the helper `name`, when history has the parent. */
  roleOf(parent: string, name: string): string | null {
    return this.cache[parent]?.spawns[name] ?? null;
  }

  /** Assistant turns in a transcript's finished runs (an agent session's earlier rotations). */
  turnsIn(file: string): number {
    return (this.cache[file]?.runs ?? []).reduce((sum, run) => sum + run.turnAt.length, 0);
  }

  /**
   * Every finished run known, oldest first: helpers with who ran them, an agent session's
   * transcripts as its one run.
   */
  runs(): RunRecord[] {
    const owned = new Map<string, AgentSession>();
    for (const session of this.sessions) for (const file of session.files) owned.set(file, session);
    const out: RunRecord[] = [];
    for (const [path, file] of Object.entries(this.cache)) {
      if (owned.has(path)) continue;
      const role = file.parent === null || file.name === null ? null : this.roleOf(file.parent, file.name);
      for (const run of file.runs) out.push(role === null ? run : { ...run, role });
    }
    for (const session of this.sessions) {
      const merged = mergeSession(
        session,
        session.files.flatMap((file) => this.cache[file]?.runs ?? []),
      );
      if (merged !== null) out.push(merged);
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Reads the transcripts that changed since the cache was written, then saves the cache.
   * `pause` runs between files (the host passes a yield so serving never waits on this).
   */
  async refresh(now: number, pause: () => Promise<void> = async () => {}): Promise<RefreshResult> {
    const since = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const found = transcripts(this.roots, since);
    const sources = this.sources();
    const tasks = new Set(sources.tasks);
    for (const session of sources.agentSessions) for (const file of session.files) tasks.add(file);
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
        const scan = scanTranscript(file.path, text, now - file.mtimeMs > QUIET_MS, task);
        next[file.path] = { size: file.size, mtimeMs: file.mtimeMs, task, parent: scan.parent, name: scan.name, spawns: scan.spawns(), runs: scan.runs() };
        read += 1;
      } catch (error) {
        this.log(`eta: could not read ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await pause();
    }
    this.cache = next;
    this.sessions = sources.agentSessions;
    if (read > 0) this.save();
    return { read, runs: this.runs().length };
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
