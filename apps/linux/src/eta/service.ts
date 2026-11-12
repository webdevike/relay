// The host side of the estimates: follows the transcript of every working session and helper the
// activity list reports, attaches `eta` to its item, and when a run ends logs what was predicted
// against how long it took. History loads in the background at start and refreshes every half hour;
// until it has loaded, only runs with a plan get an estimate.
import { open, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { ActivityEta, ActivityItem } from "@relay/protocol";
import { biasFor, calibrationAccuracy, type Accuracy, type CalibrationRecord, type Prediction } from "./accuracy";
import type { CalibrationLog } from "./calibration";
import { estimateRun, RunIndex } from "./estimate";
import type { RunHistory } from "./history";
import { checkboxSteps, TranscriptScan, type OpenRun, type PlanSteps, type RunAgent } from "./runs";

export const ETA_HISTORY_REFRESH_MS = 30 * 60 * 1000;
/** A run that replied and has been quiet this long, and is no longer reported working, has ended. */
export const ETA_SETTLE_MS = 2 * 60 * 1000;
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
  readonly now: () => number;
  readonly log: (line: string) => void;
}

interface Tracked {
  readonly id: string;
  readonly from: number;
  readonly agent: RunAgent;
  readonly predictions: Prediction[];
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

/** The plan a run keeps: its todo list, else the HANDOFF/PLAN checkboxes it wrote or read. */
function planOf(run: OpenRun): PlanSteps | null {
  if (run.steps !== null || run.planFile === null) return run.steps;
  try {
    return checkboxSteps(readFileSync(run.planFile, "utf8"));
  } catch {
    return null;
  }
}

export class EtaService {
  private index = new RunIndex([]);
  private follows = new Map<string, Follow>();
  private tracked = new Map<string, Tracked>();
  private refreshing: Promise<void> | null = null;
  private refreshedAt = 0;

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
        this.index = new RunIndex(this.deps.history.runs());
        this.deps.log(`eta: history has ${runs} runs (${this.index.size} usable), read ${read} transcripts`);
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

  /** Swaps in an index directly (tests). */
  useIndex(index: RunIndex): void {
    this.index = index;
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

  private async follow(file: string, task: boolean): Promise<Follow> {
    const follow = await (this.follows.get(file) ?? new Follow(file, task)).read();
    this.follows.set(file, follow);
    return follow;
  }

  private async estimate(item: ActivityItem, file: string, task: boolean, now: number): Promise<ActivityEta | null> {
    const run = (await this.follow(file, task)).scan.open();
    if (run === null) return null;
    const steps = planOf(run);
    const records = this.deps.calibration.records();
    const eta = estimateRun(this.index, { key: run, from: run.startedAt, turns: run.turns, steps }, now, { bias: biasFor(records, run) });
    if (eta === null) return null;
    const id = `${file}#${run.startedAt}`;
    let tracked = this.tracked.get(id);
    if (tracked === undefined) {
      tracked = { id: item.id, from: run.startedAt, agent: run.agent, predictions: [], title: run.title || item.title, seenAt: now };
      this.tracked.set(id, tracked);
    }
    tracked.seenAt = now;
    const last = tracked.predictions.at(-1);
    if ((last === undefined || last.totalMs !== eta.totalMs || last.highMs !== eta.highMs) && tracked.predictions.length < MAX_PREDICTIONS) {
      tracked.predictions.push({ elapsedMs: now - run.startedAt, totalMs: eta.totalMs, lowMs: eta.lowMs, highMs: eta.highMs, confident: eta.confidence === "confident" });
    }
    return eta;
  }

  /**
   * Logs the runs that ended: a later request started a new run in the same transcript, or the run
   * replied, went quiet and is no longer reported working. Followers of transcripts nobody reports
   * any more are dropped once their runs are settled.
   */
  private async settle(working: ReadonlySet<string>, now: number): Promise<void> {
    for (const [key, tracked] of this.tracked) {
      const file = key.slice(0, key.lastIndexOf("#"));
      let follow = this.follows.get(file);
      if (follow === undefined) {
        this.tracked.delete(key);
        continue;
      }
      if (!working.has(file)) follow = await follow.read().catch(() => follow!);
      this.follows.set(file, follow);
      const closed = follow.scan.runs().find((run) => run.startedAt === tracked.from);
      const open = follow.scan.open();
      let endedAt: number | null = null;
      let failed = false;
      if (closed !== undefined) {
        endedAt = closed.startedAt + closed.durationMs;
        failed = closed.outcome === "failed";
      } else if (open !== null && open.startedAt === tracked.from && !working.has(file) && open.replied && now - open.lastAt >= ETA_SETTLE_MS) {
        endedAt = open.lastAt;
      } else if (now - tracked.seenAt > FORGET_MS) {
        this.tracked.delete(key);
        continue;
      }
      if (endedAt === null) continue;
      this.tracked.delete(key);
      const run = closed ?? open!;
      if (!failed && endedAt > tracked.from && tracked.predictions.length > 0) {
        const record: CalibrationRecord = {
          id: tracked.id,
          title: tracked.title,
          agent: run.agent,
          kind: run.kind,
          model: run.model,
          thinking: run.thinking,
          from: tracked.from,
          actualMs: endedAt - tracked.from,
          predictions: tracked.predictions,
        };
        this.deps.calibration.add(record);
      }
    }
    for (const file of this.follows.keys()) {
      if (working.has(file)) continue;
      if (![...this.tracked.keys()].some((key) => key.startsWith(`${file}#`))) this.follows.delete(file);
    }
  }
}
