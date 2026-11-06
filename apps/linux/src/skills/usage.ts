// How often each skill is loaded and by whom, from the agents' own transcripts on this Mac:
//   - omp: a `read` tool call of `skill://<name>` (the SKILL.md, whole or a first ranged read; files
//     inside the skill and ranged re-reads are not new loads), or `/skill:<name>` typed by Isaac (a
//     `skill-prompt` message). `~/.omp/agent/sessions*` and `~/.omp/profiles/<p>/agent/sessions*`.
//   - Claude Code: a `Skill` tool call, `~/.claude/projects/**/*.jsonl`.
//   - the skill-usage hook's log (`~/.omp/usage/skills.jsonl`, Eva `.omp/hooks/skill-usage.ts`): one
//     line per load as it happens. A logged load whose tool call is also in a transcript counts once.
// Who loaded it: a subagent names its agent in its `session_init`, and its owner is whoever ran the
// top-level session above it; a top-level session is an assistant's thread or a session an assistant
// started (usage-owners.ts), a job (`You are executing Eva job "<name>"`), Elysia or Eren, else
// `other`. Over 2 GB of transcripts: each file is read once and then only from where the last scan
// stopped (by size, mtime and the bytes before that offset), as bytes, parsing only the lines that
// can hold a load. The per-file records persist in `cacheFile`, so a host restart is a warm scan, and
// a transcript deleted later keeps its loads there. The scan runs in the background at most every 10
// minutes; readers get the last snapshot.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readSessionOwners, type SessionOwners } from "./usage-owners";
import { SKILL_NAME, type SkillAgentUses, type SkillStats } from "./types";

export const USAGE_REFRESH_MS = 10 * 60_000;
/** Days in a skill's trend, today last. */
export const TREND_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const CHUNK = 1 << 20;
const TAIL = 32;
const POOL = 8;
const CACHE_VERSION = 2;
/** A logged `/skill:` load this close to one in a transcript is the same load. */
const SLASH_MATCH_MS = 2 * 60_000;
const NEWLINE = 0x0a;

const N_HEAD = Buffer.from('{"type":"session');
const N_USER = Buffer.from('"role":"user"');
const N_READ = Buffer.from('"path":"skill://');
const N_SLASH = Buffer.from('"customType":"skill-prompt"');
const N_CLAUDE = Buffer.from('"name":"Skill"');
const MESSAGE = Buffer.from('{"type":"message"');
const ASSISTANT = Buffer.from('"role":"assistant"');
const TOOL_RESULT = Buffer.from('"role":"toolResult"');
const N_ERROR = Buffer.from('"isError":true');
const N_CLAUDE_ERROR = Buffer.from('"is_error":true');
/** How far into a line its type and message role are. */
const HEAD_BYTES = 256;

export type LoadHow = "read" | "slash" | "skill-tool";

/** Who made a load: the agent, what ran it and the assistant it worked for. */
export type Runner = Pick<SkillAgentUses, "agent" | "kind" | "owner">;

/** One load in a transcript; `id` is the tool call's (or `slash:<entry id>`). */
export interface FileUse {
  skill: string;
  at: number;
  how: LoadHow;
  id: string;
}

/** What a transcript says about itself and the loads in it, read up to `offset`. */
export interface FileRecord {
  format: "omp" | "claude";
  size: number;
  mtimeMs: number;
  /** Bytes read: through the last whole line. */
  offset: number;
  /** The bytes before `offset` (base64); a rewritten file no longer has them there and is read again. */
  tail: string;
  sessionId: string | null;
  /** omp `parentSession`: the transcript that spawned this subagent. */
  parent: string | null;
  /** The subagent's agent (`session_init.agent`); null for a top-level session. */
  subagent: string | null;
  /** `job:<name>`, `eren` or `elysia`, from the session's first prompt. */
  role: string | null;
  roleSeen: boolean;
  /** Skills read so far, so a ranged re-read is not a new load. */
  seen: string[];
  uses: FileUse[];
}

const LogLine = z.object({
  at: z.number(),
  skill: z.string().regex(SKILL_NAME),
  how: z.enum(["read", "slash", "skill-tool"]),
  agent: z.string().min(1).max(100),
  kind: z.enum(["assistant", "session", "subagent", "job", "background", "claude", "other"]),
  owner: z.string().max(100).nullable(),
  sessionId: z.string().nullable(),
  toolCallId: z.string().nullable(),
});
type LogLine = z.infer<typeof LogLine>;

const Cache = z.object({ v: z.literal(CACHE_VERSION), files: z.record(z.string(), z.custom<FileRecord>()) });

const Header = z.object({ type: z.string(), id: z.string().optional(), parentSession: z.string().optional(), agent: z.string().optional(), task: z.string().optional() });
const Stamped = z.object({ timestamp: z.string().optional() });
const ToolCall = z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.object({ path: z.string() }) });
const OmpMessage = Stamped.extend({ message: z.object({ role: z.string(), content: z.union([z.string(), z.array(z.unknown())]) }) });
const SkillPrompt = Stamped.extend({ id: z.string(), content: z.string() });
const ClaudeToolUse = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.literal("Skill"), input: z.object({ skill: z.string() }) });
const ClaudeLine = Stamped.extend({ sessionId: z.string().optional(), message: z.object({ content: z.array(z.unknown()) }) });
const ClaudeError = z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), is_error: z.literal(true) });
const ReadError = z.object({ message: z.object({ role: z.literal("toolResult"), toolCallId: z.string(), isError: z.literal(true) }) });

/** A `skill://` path's skill, and whether it is a ranged read; null for a file inside a skill or no skill. */
export function skillOfPath(path: string): { skill: string; ranged: boolean } | null {
  if (!path.startsWith("skill://")) return null;
  let rest = path.slice("skill://".length).split(/[?#]/)[0] ?? "";
  let ranged = false;
  // Read selectors (`:50-80`, `:raw`, `:5-16,960-973`) trail the path; plugin names also hold a `:`.
  for (let m = /:([^:/]*)$/.exec(rest); m !== null; m = /:([^:/]*)$/.exec(rest)) {
    const selector = m[1] ?? "";
    if (!/^(?:raw|img|conflicts|[\d,+-]*\d[\d,+-]*)$/.test(selector)) break;
    if (/\d/.test(selector)) ranged = true;
    rest = rest.slice(0, -m[0].length);
  }
  const parts = rest.split("/");
  if (parts.at(-1) === "SKILL.md") parts.pop();
  // `agents/hallmark` is omp's name for a colliding copy; anything deeper (or with a dot) is a file inside a skill.
  const skill = parts.length === 1 ? parts[0] : parts.length === 2 && !(parts[1] ?? "").includes(".") ? parts.join("/") : undefined;
  return skill !== undefined && SKILL_NAME.test(skill) ? { skill, ranged } : null;
}

/** `job:<name>`, `eren` or `elysia` from a session's first prompt; null otherwise. */
export function roleOfPrompt(text: string): string | null {
  const head = text.slice(0, 4000);
  const job = /You are executing Eva job "([a-z0-9][a-z0-9_-]*)"/.exec(head)?.[1];
  if (job !== undefined) return `job:${job}`;
  const who = /\bYou are (Eren|Elysia)\b/.exec(head)?.[1];
  return who === undefined ? null : who.toLowerCase();
}

const TextPart = z.object({ type: z.literal("text"), text: z.string() });

function textOf(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  for (const part of content) {
    const text = TextPart.safeParse(part);
    if (text.success) return text.data.text;
  }
  return "";
}

function parseLine(line: Buffer): unknown {
  try {
    return JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function timeOf(stamp: string | undefined, fallback: number): number {
  const at = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return Number.isNaN(at) ? fallback : at;
}

function freshRecord(format: FileRecord["format"]): FileRecord {
  return { format, size: 0, mtimeMs: 0, offset: 0, tail: "", sessionId: null, parent: null, subagent: null, role: null, roleSeen: format === "claude", seen: [], uses: [] };
}

/** Each line of `data` holding `needle`, once per line, in order: [start, end) without the newline. */
function* linesWith(data: Buffer, needle: Buffer): Generator<[number, number, number]> {
  let from = 0;
  for (;;) {
    const hit = data.indexOf(needle, from);
    if (hit < 0) return;
    const start = data.lastIndexOf(NEWLINE, hit) + 1;
    let end = data.indexOf(NEWLINE, hit);
    if (end < 0) end = data.length;
    yield [start, end, hit];
    from = end + 1;
  }
}

/** Whether the line [start, end) is a `{"type":"message"` entry whose head (the message role) holds `needle`. */
function messageWith(data: Buffer, start: number, end: number, needle: Buffer): boolean {
  const head = data.subarray(start, Math.min(end, start + HEAD_BYTES));
  return head.subarray(0, MESSAGE.length).equals(MESSAGE) && head.includes(needle);
}

/** Takes back the load of tool call `id`: its result says it failed (an unknown skill, a missing file). */
function dropFailed(record: FileRecord, id: string): void {
  const failed = record.uses.find((use) => use.id === id);
  if (failed === undefined) return;
  record.uses = record.uses.filter((use) => use !== failed);
  if (!record.uses.some((use) => use.skill === failed.skill)) record.seen = record.seen.filter((skill) => skill !== failed.skill);
}

/** Reads the loads and the session facts out of `data` (whole lines) into `record`. */
function collect(data: Buffer, record: FileRecord, fallbackAt: number): void {
  if (record.format === "claude") {
    for (const [start, end] of linesWith(data, N_CLAUDE)) {
      const line = ClaudeLine.safeParse(parseLine(data.subarray(start, end)));
      if (!line.success) continue;
      record.sessionId ??= line.data.sessionId ?? null;
      for (const part of line.data.message.content) {
        const use = ClaudeToolUse.safeParse(part);
        if (use.success && SKILL_NAME.test(use.data.input.skill)) record.uses.push({ skill: use.data.input.skill, at: timeOf(line.data.timestamp, fallbackAt), how: "skill-tool", id: use.data.id });
      }
    }
    for (const [start, end] of linesWith(data, N_CLAUDE_ERROR)) {
      const line = ClaudeLine.safeParse(parseLine(data.subarray(start, end)));
      if (!line.success) continue;
      for (const part of line.data.message.content) {
        const result = ClaudeError.safeParse(part);
        if (result.success) dropFailed(record, result.data.tool_use_id);
      }
    }
    return;
  }
  for (const [start, end, hit] of linesWith(data, N_HEAD)) {
    if (hit !== start) continue;
    const head = Header.safeParse(parseLine(data.subarray(start, end)));
    if (!head.success) continue;
    if (head.data.type === "session") {
      record.sessionId ??= head.data.id ?? null;
      record.parent ??= head.data.parentSession ?? null;
    } else if (head.data.type === "session_init") {
      record.subagent = head.data.agent ?? "task";
      if (!record.roleSeen) record.role = roleOfPrompt(head.data.task ?? "");
      record.roleSeen = true;
    }
  }
  if (!record.roleSeen) {
    for (const [start, end] of linesWith(data, N_USER)) {
      if (!messageWith(data, start, end, N_USER)) continue;
      const line = OmpMessage.safeParse(parseLine(data.subarray(start, end)));
      if (!line.success) continue;
      record.role = roleOfPrompt(textOf(line.data.message.content));
      record.roleSeen = true;
      break;
    }
  }
  for (const [start, end] of linesWith(data, N_READ)) {
    if (!messageWith(data, start, end, ASSISTANT)) continue;
    const line = OmpMessage.safeParse(parseLine(data.subarray(start, end)));
    if (!line.success || typeof line.data.message.content === "string") continue;
    for (const part of line.data.message.content) {
      const call = ToolCall.safeParse(part);
      if (!call.success || call.data.name !== "read") continue;
      const read = skillOfPath(call.data.arguments.path);
      if (read === null || (read.ranged && record.seen.includes(read.skill))) continue;
      if (!record.seen.includes(read.skill)) record.seen.push(read.skill);
      record.uses.push({ skill: read.skill, at: timeOf(line.data.timestamp, fallbackAt), how: "read", id: call.data.id });
    }
  }
  for (const [start, end] of linesWith(data, N_SLASH)) {
    const line = SkillPrompt.safeParse(parseLine(data.subarray(start, end)));
    const skill = line.success ? /invoked the "([^"]+)" skill/.exec(line.data.content.slice(0, 400))?.[1] : undefined;
    if (!line.success || skill === undefined || !SKILL_NAME.test(skill)) continue;
    record.uses.push({ skill, at: timeOf(line.data.timestamp, fallbackAt), how: "slash", id: `slash:${line.data.id}` });
  }
  for (const [start, end] of linesWith(data, N_ERROR)) {
    if (record.uses.length === 0 || !messageWith(data, start, end, TOOL_RESULT)) continue;
    const line = ReadError.safeParse(parseLine(data.subarray(start, end)));
    if (line.success) dropFailed(record, line.data.message.toolCallId);
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * The transcript at `path` read on from `previous` (from the start when there is none, it shrank, or
 * the bytes before its offset changed). Only whole lines are read: a line still being written waits.
 */
export async function scanTranscript(path: string, format: FileRecord["format"], previous: FileRecord | null, stats: { size: number; mtimeMs: number }): Promise<{ record: FileRecord; read: number }> {
  const handle = await open(path, "r");
  try {
    let record = freshRecord(format);
    if (previous !== null && previous.format === format && stats.size >= previous.offset) {
      const tail = previous.offset === 0 ? "" : (await readAt(handle, Math.max(0, previous.offset - TAIL), Math.min(TAIL, previous.offset))).toString("base64");
      if (tail === previous.tail) record = { ...previous, seen: [...previous.seen], uses: [...previous.uses] };
    }
    const from = record.offset;
    let base = from;
    let carry = Buffer.alloc(0);
    const chunk = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, base + carry.length);
      if (bytesRead === 0) break;
      const data = carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const end = data.lastIndexOf(NEWLINE) + 1;
      collect(data.subarray(0, end), record, stats.mtimeMs);
      base += end;
      carry = Buffer.from(data.subarray(end));
    }
    record.offset = base;
    record.tail = base === 0 ? "" : (await readAt(handle, Math.max(0, base - TAIL), Math.min(TAIL, base))).toString("base64");
    record.size = stats.size;
    record.mtimeMs = stats.mtimeMs;
    return { record, read: base - from };
  } finally {
    await handle.close();
  }
}

export interface UsageDeps {
  readonly home: string;
  /** The Eva checkout: agent sessions, assistants' started sessions, jobs. Null skips them. */
  readonly agentHome: string | null;
  /** The host's assistant thread records (`<relay config>/assistants`); null skips them. */
  readonly assistantsDir: string | null;
  /** Where the per-transcript records persist; null keeps them in memory. */
  readonly cacheFile: string | null;
  /** The skill-usage hook's log; null reads none. */
  readonly logFile: string | null;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** How the last scan went. */
export interface ScanStats {
  /** Transcripts found. */
  files: number;
  /** Transcripts read (new or grown). */
  read: number;
  /** Bytes read. */
  bytes: number;
  ms: number;
}

/** Local midnight of `at`. */
function dayStart(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export class SkillUsageIndex {
  private files = new Map<string, FileRecord>();
  private logEntries: LogLine[] = [];
  private logOffset = 0;
  private snapshotByName: Map<string, SkillStats> | null = null;
  private running: Promise<void> | null = null;
  private startedAt: number | null = null;
  private readonly now: () => number;
  /** The last scan's numbers; null before one finished. */
  lastScan: ScanStats | null = null;

  constructor(private readonly deps: UsageDeps) {
    this.now = deps.now ?? Date.now;
    if (deps.cacheFile === null) return;
    try {
      const cache = Cache.safeParse(JSON.parse(readFileSync(deps.cacheFile, "utf8")));
      if (cache.success) this.files = new Map(Object.entries(cache.data.files));
    } catch {
      return;
    }
    // A host restart answers from the stored records until its first scan.
    this.snapshotByName = this.aggregate(readSessionOwners(deps.agentHome, deps.assistantsDir));
  }

  /** The last snapshot of `name`; null before the first scan finished. Starts a background scan when due. */
  usage(name: string): SkillStats | null {
    this.refreshIfDue();
    if (this.snapshotByName === null) return null;
    return this.snapshotByName.get(name) ?? { uses: 0, uses7d: 0, uses30d: 0, lastUsedAt: null, firstUsedAt: null, byAgent: [], daily: Array.from({ length: TREND_DAYS }, () => 0) };
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

  /**
   * Who ran each transcript, by absolute path, after a scan (joined when one runs; warm it reads only
   * what grew). Settings > Usage attributes omp's per-session costs with it. Null for a path never scanned.
   */
  async runners(): Promise<(path: string) => Runner | null> {
    await this.refresh();
    const owners = readSessionOwners(this.deps.agentHome, this.deps.assistantsDir);
    return (path) => {
      const record = this.files.get(path);
      return record === undefined ? null : this.runner(path, record, owners);
    };
  }

  private async roots(): Promise<{ dir: string; format: FileRecord["format"] }[]> {
    const { home } = this.deps;
    const agentDirs = [join(home, ".omp", "agent")];
    const profiles = join(home, ".omp", "profiles");
    for (const profile of await readdir(profiles).catch(() => [] as string[])) if (!profile.startsWith(".")) agentDirs.push(join(profiles, profile, "agent"));
    return [
      ...agentDirs.flatMap((dir) => [
        { dir: join(dir, "sessions"), format: "omp" as const },
        { dir: join(dir, "sessions-archive"), format: "omp" as const },
      ]),
      { dir: join(home, ".claude", "projects"), format: "claude" },
    ];
  }

  private async scan(): Promise<void> {
    const began = performance.now();
    const due: { path: string; format: FileRecord["format"]; size: number; mtimeMs: number }[] = [];
    let found = 0;
    for (const root of await this.roots()) {
      const entries = await readdir(root.dir, { recursive: true }).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const path = join(root.dir, entry);
        const stats = await stat(path).catch(() => null);
        if (stats?.isFile() !== true) continue;
        found += 1;
        const cached = this.files.get(path);
        if (cached?.size === stats.size && cached.mtimeMs === stats.mtimeMs) continue;
        due.push({ path, format: root.format, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
    let bytes = 0;
    let next = 0;
    const work = async (): Promise<void> => {
      for (let item = due[next++]; item !== undefined; item = due[next++]) {
        const previous = this.files.get(item.path) ?? null;
        const scanned = await scanTranscript(item.path, item.format, previous, item).catch(() => null);
        if (scanned === null) continue;
        bytes += scanned.read;
        this.files.set(item.path, scanned.record);
      }
    };
    await Promise.all(Array.from({ length: POOL }, work));
    await this.readLog();
    this.snapshotByName = this.aggregate(readSessionOwners(this.deps.agentHome, this.deps.assistantsDir));
    if (due.length > 0) this.save();
    this.lastScan = { files: found, read: due.length, bytes, ms: Math.round(performance.now() - began) };
    this.deps.log?.(`skills usage: ${String(due.length)} of ${String(found)} transcripts read (${String(Math.round(bytes / 1e6))} MB) in ${String(this.lastScan.ms)} ms`);
  }

  /** New lines of the hook's log; the whole log again when it shrank. */
  private async readLog(): Promise<void> {
    if (this.deps.logFile === null) return;
    const stats = await stat(this.deps.logFile).catch(() => null);
    if (stats === null) return;
    if (stats.size < this.logOffset) {
      this.logOffset = 0;
      this.logEntries = [];
    }
    if (stats.size === this.logOffset) return;
    const handle = await open(this.deps.logFile, "r");
    try {
      const data = await readAt(handle, this.logOffset, stats.size - this.logOffset);
      const end = data.lastIndexOf(NEWLINE) + 1;
      for (const text of data.subarray(0, end).toString("utf8").split("\n")) {
        if (text === "") continue;
        const line = LogLine.safeParse(parseLine(Buffer.from(text)));
        if (line.success) this.logEntries.push(line.data);
      }
      this.logOffset += end;
    } finally {
      await handle.close();
    }
  }

  private save(): void {
    const file = this.deps.cacheFile;
    if (file === null) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${String(process.pid)}.tmp`;
      writeFileSync(temp, JSON.stringify({ v: CACHE_VERSION, files: Object.fromEntries(this.files) }));
      renameSync(temp, file);
    } catch (error) {
      this.deps.log?.(`skills usage: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Who ran the transcript at `path`. */
  private runner(path: string, record: FileRecord, owners: SessionOwners, depth = 0): Runner {
    if (record.format === "claude") return { agent: "claude-code", kind: "claude", owner: null };
    if (record.subagent !== null) {
      const parentRecord = record.parent === null || depth > 8 ? undefined : this.files.get(record.parent);
      const parent = parentRecord === undefined || record.parent === null ? null : this.runner(record.parent, parentRecord, owners, depth + 1);
      const owner = parent === null ? null : parent.kind === "assistant" ? parent.agent : parent.owner;
      if (record.role === "eren" || record.role === "elysia") return { agent: record.role, kind: "background", owner };
      return { agent: record.subagent, kind: "subagent", owner };
    }
    const known = owners.sessions.get(path);
    if (known !== undefined) return { ...known };
    if (record.role?.startsWith("job:") === true) {
      const job = record.role.slice("job:".length);
      return { agent: job, kind: "job", owner: owners.jobs.get(job) ?? null };
    }
    if (record.role === "eren" || record.role === "elysia") return { agent: record.role, kind: "background", owner: null };
    return { agent: "other", kind: "other", owner: null };
  }

  private aggregate(owners: SessionOwners): Map<string, SkillStats> {
    const now = this.now();
    const today = dayStart(now);
    const out = new Map<string, SkillStats>();
    const byAgent = new Map<string, Map<string, SkillAgentUses>>();
    const add = (skill: string, at: number, who: Runner): void => {
      let usage = out.get(skill);
      if (usage === undefined) {
        usage = { uses: 0, uses7d: 0, uses30d: 0, lastUsedAt: null, firstUsedAt: null, byAgent: [], daily: Array.from({ length: TREND_DAYS }, () => 0) };
        out.set(skill, usage);
      }
      usage.uses += 1;
      if (at >= now - 7 * DAY_MS) usage.uses7d += 1;
      if (at >= now - 30 * DAY_MS) usage.uses30d += 1;
      if (usage.lastUsedAt === null || at > usage.lastUsedAt) usage.lastUsedAt = at;
      if (usage.firstUsedAt === null || at < usage.firstUsedAt) usage.firstUsedAt = at;
      const daysAgo = Math.round((today - dayStart(at)) / DAY_MS);
      if (daysAgo >= 0 && daysAgo < TREND_DAYS) usage.daily[TREND_DAYS - 1 - daysAgo] = (usage.daily[TREND_DAYS - 1 - daysAgo] ?? 0) + 1;
      const agents = byAgent.get(skill) ?? new Map<string, SkillAgentUses>();
      byAgent.set(skill, agents);
      const key = `${who.kind}\u0000${who.agent}\u0000${who.owner ?? ""}`;
      const row = agents.get(key);
      if (row === undefined) agents.set(key, { ...who, uses: 1, lastUsedAt: at });
      else {
        row.uses += 1;
        row.lastUsedAt = Math.max(row.lastUsedAt, at);
      }
    };
    const counted = new Set<string>();
    const slashes = new Map<string, number[]>();
    for (const [path, record] of this.files) {
      if (record.uses.length === 0) continue;
      const who = this.runner(path, record, owners);
      for (const use of record.uses) {
        // A forked or archived copy of a transcript repeats its tool call ids.
        if (counted.has(use.id)) continue;
        counted.add(use.id);
        if (use.how === "slash") {
          const key = `${record.sessionId ?? path}\u0000${use.skill}`;
          slashes.set(key, [...(slashes.get(key) ?? []), use.at]);
        }
        add(use.skill, use.at, who);
      }
    }
    for (const line of this.logEntries) {
      if (line.toolCallId !== null && counted.has(line.toolCallId)) continue;
      if (line.how === "slash" && (slashes.get(`${line.sessionId ?? ""}\u0000${line.skill}`) ?? []).some((at) => Math.abs(at - line.at) <= SLASH_MATCH_MS)) continue;
      if (line.toolCallId !== null) counted.add(line.toolCallId);
      add(line.skill, line.at, { agent: line.agent, kind: line.kind, owner: line.owner });
    }
    for (const [skill, usage] of out) usage.byAgent = [...(byAgent.get(skill)?.values() ?? [])].sort((a, b) => b.uses - a.uses || b.lastUsedAt - a.lastUsedAt);
    return out;
  }
}
