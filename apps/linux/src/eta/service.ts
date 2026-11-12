// The host side of the estimates: follows the transcript of every working session and helper the
// activity list reports, attaches `eta` to its item, and when a run ends logs what was predicted
// against how long it took. History loads in the background at start and refreshes every half hour;
// until it has loaded, only runs with a plan get an estimate, and none is drawn solid.
//
// A helper is estimated against helpers its parent's `task` call gave the same agent definition. A
// transcript that belongs to an Eva agent session is the whole session: from its start across
// rotations, its HANDOFF checkboxes as the plan, never past its `--max-time`.
import { open, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { ActivityEta, ActivityItem } from "@relay/protocol";
import { biasFor, calibrationAccuracy, ConfidenceTable, TRUST_ERROR, TRUST_MIN, type Accuracy, type CalibrationRecord, type Prediction } from "./accuracy";
import type { CalibrationLog } from "./calibration";
import { estimateRun, RunIndex } from "./estimate";
import type { AgentSession, RunHistory, SessionSources } from "./history";
import { checkboxSteps, TranscriptScan, type OpenRun, type PlanSteps, type RunAgent } from "./runs";

export const ETA_HISTORY_REFRESH_MS = 30 * 60 * 1000;
/** A run that replied and has been quiet this long, and is no longer reported working, has ended. */
export const ETA_SETTLE_MS = 2 * 60 * 1000;
/** How long the agent sessions list is reused before it is read again. */
const SOURCES_MS = 60 * 1000;
/** A run nobody has reported for this long is forgotten without a log line. */
const FORGET_MS = 6 * 60 * 60 * 1000;
/** Predictions kept per run for the log. */
const MAX_PREDICTIONS = 60;
/** The most a transcript is read in one go when first followed (its tail; older runs are history's). */
const FIRST_READ_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const HEADER_LINE = /^\{"type":"(title|session|model_change|thinking_level_change)"/;

export interface EtaServiceDeps {
  readonly history: RunHistory;
  readonly calibration: CalibrationLog;
  /** The transcript of an omp session, by id. */
  readonly sessionFile: (sessionId: string) => string | null;
  /** True when a session is an assistant's or a job's task (not a chat Isaac runs himself). */
  readonly isTask: (sessionId: string, file: string) => boolean;
  /** The agent home's tasks and agent sessions (`sessionSources`). */
  readonly sources: () => SessionSources;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

interface Tracked {
  readonly id: string;
  /** The transcript followed; for an agent session, the one it writes now. */
  file: string;
  readonly from: number;
  readonly agent: RunAgent;
  readonly role: string | null;
  readonly predictions: Prediction[];
  /** Set for an agent session: it ends when its record says so. */
  readonly session: AgentSession | null;
  title: string;
  seenAt: number;
}

class Follow {
  readonly scan: TranscriptScan;
  offset = 0;
  private partial = "";

  constructor(
    readonly file: string,
    private readonly task: boolean,
  ) {
    this.scan = new TranscriptScan(file, task);
  }

  /** Reads what was appended since last time. A transcript that shrank was rewritten: start over. */
  async read(): Promise<Follow> {
    const size = (await stat(this.file)).size;
    if (size < this.offset) return new Follow(this.file, this.task).read();
    if (size === this.offset) return this;
    const start = this.offset === 0 ? Math.max(0, size - FIRST_READ_BYTES) : this.offset;
    const handle = await open(this.file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = this.partial + buffer.subarray(0, bytesRead).toString("utf8");
      if (this.offset === 0 && start > 0) {
        // A long transcript is read from its tail: the header (title, model, thinking, parent) comes
        // from its head, and the line the tail cuts through is dropped.
        const head = Buffer.alloc(HEAD_BYTES);
        const got = (await handle.read(head, 0, HEAD_BYTES, 0)).bytesRead;
        for (const line of head.subarray(0, got).toString("utf8").split("\n")) if (HEADER_LINE.test(line)) this.scan.line(line);
        text = text.slice(text.indexOf("\n") + 1);
      }
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      for (const line of lines) this.scan.line(line);
      this.offset = start + bytesRead;
    } finally {
      await handle.close();
    }
    return this;
  }
}

/** The `task` calls of a parent transcript, read whole once and then as it grows: who each helper is. */
class SpawnReader {
  private readonly scan: TranscriptScan;
  private offset = 0;
  private partial = "";

  constructor(private readonly file: string) {
    this.scan = new TranscriptScan(file);
  }

  async roleOf(name: string): Promise<string | null> {
    const known = this.scan.spawns()[name];
    if (known !== undefined) return known;
    const size = (await stat(this.file)).size;
    if (size > this.offset) {
      const handle = await open(this.file, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        const lines = (this.partial + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
        this.partial = lines.pop() ?? "";
        for (const line of lines) if (line.includes('"name":"task"')) this.scan.line(line);
        this.offset += bytesRead;
      } finally {
        await handle.close();
      }
    }
    return this.scan.spawns()[name] ?? null;
  }
}

/** The plan a run keeps: its todo list, else the HANDOFF/PLAN checkboxes it wrote or read, else its agent session's HANDOFF. */
function planOf(run: OpenRun, handoff: string | null): PlanSteps | null {
  if (run.steps !== null) return run.steps;
  for (const file of [run.planFile, handoff]) {
    if (file === null) continue;
    try {
      const steps = checkboxSteps(readFileSync(file, "utf8"));
      if (steps !== null) return steps;
    } catch {
      // A plan file that is gone says nothing.
    }
  }
  return null;
}

export class EtaService {
  private index = new RunIndex([]);
  private table = ConfidenceTable.EMPTY;
  private follows = new Map<string, Follow>();
  private spawns = new Map<string, SpawnReader>();
  private tracked = new Map<string, Tracked>();
  private refreshing: Promise<void> | null = null;
  private refreshedAt = 0;
  private sources: { at: number; sessions: readonly AgentSession[] } | null = null;

  constructor(private readonly deps: EtaServiceDeps) {}

  /** Starts (or, after `ETA_HISTORY_REFRESH_MS`, repeats) the history read in the background. */
  refresh(): void {
    const now = this.deps.now();
    if (this.refreshing !== null || (this.refreshedAt !== 0 && now - this.refreshedAt < ETA_HISTORY_REFRESH_MS)) return;
    this.refreshedAt = now;
    const yieldNow = (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      return promise;
    };
    this.refreshing = this.deps.history
      .refresh(now, yieldNow)
      .then(({ read, runs }) => {
        const all = this.deps.history.runs();
        this.index = new RunIndex(all);
        this.table = ConfidenceTable.build(all);
        const trusted = Object.values(this.table.cells).filter((cell) => cell.n >= TRUST_MIN && cell.medianError < TRUST_ERROR).length;
        this.deps.log(`eta: history has ${runs} runs (${this.index.size} usable), read ${read} transcripts; ${trusted} of ${Object.keys(this.table.cells).length} replay cells draw solid`);
      })
      .catch((error: unknown) => this.deps.log(`eta: history read failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.refreshing = null;
      });
  }

  /** Waits for a history read in flight (tests and the CLI). */
  async loaded(): Promise<void> {
    await this.refreshing;
  }

  /** Swaps in an index and confidence table directly (tests). */
  useIndex(index: RunIndex, table: ConfidenceTable = ConfidenceTable.EMPTY): void {
    this.index = index;
    this.table = table;
  }

  accuracy(): Accuracy {
    return calibrationAccuracy(this.deps.calibration.records());
  }

  /** `items` with `eta` on each working session and helper the estimator can say something about. */
  async annotate(items: readonly ActivityItem[]): Promise<ActivityItem[]> {
    this.refresh();
    const now = this.deps.now();
    const out: ActivityItem[] = [];
    const working = new Set<string>();
    for (const item of items) {
      const target = this.target(item);
      if (target === null) {
        out.push(item);
        continue;
      }
      working.add(target.file);
      const eta = await this.estimate(item, target.file, target.task, now).catch((error: unknown) => {
        this.deps.log(`eta: ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      out.push(eta === null ? item : { ...item, eta });
    }
    await this.settle(working, now);
    return out;
  }

  private target(item: ActivityItem): { file: string; task: boolean } | null {
    if (item.status !== "working") return null;
    if (item.kind === "helper" && item.open.to === "subagent") return { file: item.open.file, task: false };
    if (item.kind !== "session" || item.open.to !== "chat" || item.open.session === undefined) return null;
    const file = this.deps.sessionFile(item.open.session);
    return file === null ? null : { file, task: this.deps.isTask(item.open.session, file) };
  }

  /** The agent sessions, read at most once a minute. */
  private agentSessions(now: number): readonly AgentSession[] {
    if (this.sources === null || now - this.sources.at > SOURCES_MS) this.sources = { at: now, sessions: this.deps.sources().agentSessions };
    return this.sources.sessions;
  }

  private async follow(file: string, task: boolean): Promise<Follow> {
    const follow = await (this.follows.get(file) ?? new Follow(file, task)).read();
    this.follows.set(file, follow);
    return follow;
  }

  /** Who a helper is: from history's copy of its parent, else from the parent transcript itself. */
  private async helperRole(scan: TranscriptScan): Promise<string | null> {
    const parent = scan.parent;
    const name = scan.name;
    if (parent === null || name === null) return null;
    const known = this.deps.history.roleOf(parent, name);
    if (known !== null) return known;
    let reader = this.spawns.get(parent);
    if (reader === undefined) {
      reader = new SpawnReader(parent);
      this.spawns.set(parent, reader);
    }
    return reader.roleOf(name).catch(() => null);
  }

  private async estimate(item: ActivityItem, file: string, task: boolean, now: number): Promise<ActivityEta | null> {
    const scan = (await this.follow(file, task)).scan;
    const session = this.agentSessions(now).find((candidate) => candidate.endedAt === null && candidate.files.includes(file)) ?? null;
    if (session !== null) scan.role = session.role;
    else if (scan.parent !== null && scan.role === null) scan.role = await this.helperRole(scan);
    const run = scan.open();
    if (run === null) return null;
    const steps = planOf(run, session?.handoff ?? null);
    const from = session?.startedAt ?? run.startedAt;
    // An agent session's earlier rotations count toward its pace.
    const turns = run.turns + (session === null ? 0 : session.files.filter((other) => other !== file).reduce((sum, other) => sum + this.deps.history.turnsIn(other), 0));
    const records = this.deps.calibration.records();
    const eta = estimateRun(this.index, { key: run, from, turns, steps, ...(session === null ? {} : { limitMs: session.limitMs }) }, now, { bias: biasFor(records, run), trust: this.table.trust });
    if (eta === null) return null;
    const id = session === null ? `${file}#${run.startedAt}` : `session#${session.startedAt}#${session.title}`;
    let tracked = this.tracked.get(id);
    if (tracked === undefined) {
      tracked = { id: item.id, file, from, agent: run.agent, role: run.role, predictions: [], session, title: session?.title ?? (run.title || item.title), seenAt: now };
      this.tracked.set(id, tracked);
    }
    tracked.file = file;
    tracked.seenAt = now;
    const last = tracked.predictions.at(-1);
    if ((last === undefined || last.totalMs !== eta.totalMs || last.highMs !== eta.highMs) && tracked.predictions.length < MAX_PREDICTIONS) {
      tracked.predictions.push({ elapsedMs: now - from, totalMs: eta.totalMs, lowMs: eta.lowMs, highMs: eta.highMs, confident: eta.confidence === "confident" });
    }
    return eta;
  }

  /**
   * Logs the runs that ended: a later request started a new run in the same transcript, the run
   * replied, went quiet and is no longer reported working, or (an agent session) its record says it
   * ended. Followers of transcripts nobody reports any more are dropped once their runs are settled.
   */
  private async settle(working: ReadonlySet<string>, now: number): Promise<void> {
    for (const [key, tracked] of this.tracked) {
      const ended = tracked.session === null ? await this.runEnd(tracked, working, now) : this.sessionEnd(tracked, now);
      if (ended === "forget") {
        this.tracked.delete(key);
        continue;
      }
      if (ended === null) continue;
      this.tracked.delete(key);
      const run = this.follows.get(tracked.file)?.scan.open();
      if (!ended.failed && ended.at > tracked.from && tracked.predictions.length > 0) {
        const record: CalibrationRecord = {
          id: tracked.id,
          title: tracked.title,
          agent: tracked.agent,
          role: tracked.role,
          kind: run?.kind ?? "other",
          model: run?.model ?? null,
          thinking: run?.thinking ?? null,
          from: tracked.from,
          actualMs: ended.at - tracked.from,
          predictions: tracked.predictions,
        };
        this.deps.calibration.add(record);
      }
    }
    for (const file of this.follows.keys()) {
      if (working.has(file)) continue;
      if (![...this.tracked.values()].some((tracked) => tracked.file === file)) this.follows.delete(file);
    }
  }

  /** When a transcript's run ended, null while it goes on, `forget` when nobody has reported it for long. */
  private async runEnd(tracked: Tracked, working: ReadonlySet<string>, now: number): Promise<{ at: number; failed: boolean } | null | "forget"> {
    let follow = this.follows.get(tracked.file);
    if (follow === undefined) return "forget";
    if (!working.has(tracked.file)) follow = await follow.read().catch(() => follow!);
    this.follows.set(tracked.file, follow);
    const closed = follow.scan.runs().find((run) => run.startedAt === tracked.from);
    if (closed !== undefined) return { at: closed.startedAt + closed.durationMs, failed: closed.outcome === "failed" };
    const open = follow.scan.open();
    if (open !== null && open.startedAt === tracked.from && !working.has(tracked.file) && open.replied && now - open.lastAt >= ETA_SETTLE_MS) return { at: open.lastAt, failed: false };
    return now - tracked.seenAt > FORGET_MS ? "forget" : null;
  }

  /** When an agent session ended, from its record: `done` and `timeout` ran their course. */
  private sessionEnd(tracked: Tracked, now: number): { at: number; failed: boolean } | null | "forget" {
    const session = tracked.session!;
    const record = this.agentSessions(now).find((candidate) => candidate.startedAt === session.startedAt && candidate.title === session.title);
    if (record?.endedAt !== undefined && record.endedAt !== null) return { at: record.endedAt, failed: record.state !== "done" && record.state !== "timeout" };
    return now - tracked.seenAt > FORGET_MS ? "forget" : null;
  }
}
