// What the atomic-agents service recorded about specialist runs (`agents_ask`), read from its journal
// (`<home>/events.ndjson`, appended by the service; widgets/bus.ts has the same no-import rule): the
// host settles each assistant thread's running badges against it, so a run that finished while no one
// polled `agents_result` shows done. The fold follows packages/atomic-agents/src/core/Requests.ts
// `Tracker` (run.requested / run.rejected, an ask pair's request, job.started naming the request, then the
// run's job.succeeded / job.failed or an ask pair's reply); only what a badge needs.

import { existsSync, statSync, watchFile, unwatchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TRIAL_SWITCH_BADGE_MS,
  agentsCaption,
  expireAgentRuns,
  settleAgentRuns,
  type AgentRun,
  type AssistantMessage,
} from "@relay/protocol";
import {
  EMPTY_TRIALS_FOLD,
  trialsOfJournal,
  trialsSignature,
  type TrialBadges,
  type TrialsFold,
} from "../trials/book";

const RUN_REQUESTED = "atomic-agents/run.requested";
const RUN_REJECTED = "atomic-agents/run.rejected";
const ASK_RUN_PREFIX = "ask-";
/** How often the journal's size and time are read, and how long a burst of appends settles before listeners hear. */
const JOURNAL_POLL_MS = 1000;
/** How often the folded runs are re-judged while a listener hears them: a run past its time limit expires with no journal write to say so. */
const TICK_MS = 30_000;

interface JournalEvent {
  readonly type: string;
  readonly component: string;
  readonly job: string;
  readonly run: string;
  readonly at: string;
  readonly data: Record<string, unknown> | null;
}

interface Tracked {
  agent: string | undefined;
  requestedAt: string | undefined;
  rejected: string | undefined;
  started:
    | {
        readonly at: string;
        readonly model?: string;
        readonly thinking?: string;
        readonly fellBack?: boolean;
      }
    | undefined;
  finished:
    | {
        readonly ok: boolean;
        readonly seconds: number | undefined;
        readonly error: string | undefined;
      }
    | undefined;
  replied: boolean;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parse = (line: string): JournalEvent | null => {
  try {
    const event = record(JSON.parse(line));
    const type = text(event?.["type"]);
    const at = text(event?.["at"]);
    if (event === null || type === undefined || at === undefined) return null;
    return {
      type,
      at,
      component: text(event["component"]) ?? "",
      job: text(event["job"]) ?? "",
      run: text(event["run"]) ?? "",
      data: record(event["data"]),
    };
  } catch {
    return null;
  }
};

/**
 * Every specialist run in the journal's `lines`, folded to what a badge shows: `run` is the request id
 * (`agents_ask`'s run), `startedAt` the ask's time. Journal lines that are no run's (job output, other
 * components' events) are skipped before they are parsed.
 */
export function specialistRunsOfJournal(lines: readonly string[]): AgentRun[] {
  const byRequest = new Map<string, Tracked>();
  const byRun = new Map<string, Tracked>();
  const open = (requestId: string): Tracked => {
    let tracked = byRequest.get(requestId);
    if (tracked === undefined) {
      tracked = {
        agent: undefined,
        requestedAt: undefined,
        rejected: undefined,
        started: undefined,
        finished: undefined,
        replied: false,
      };
      byRequest.set(requestId, tracked);
    }
    return tracked;
  };
  for (const line of lines) {
    if (
      !line.includes('"requestId"') &&
      !line.includes("/job.succeeded") &&
      !line.includes("/job.failed")
    )
      continue;
    const event = parse(line);
    if (event === null) continue;
    const requestId = text(event.data?.["requestId"]);
    if (event.type === RUN_REQUESTED) {
      const agent = text(event.data?.["agent"]);
      if (requestId === undefined || agent === undefined) continue;
      const tracked = open(requestId);
      tracked.agent = agent;
      tracked.requestedAt = event.at;
      continue;
    }
    if (event.type === RUN_REJECTED) {
      if (requestId === undefined) continue;
      const tracked = byRequest.get(requestId);
      if (tracked !== undefined) {
        tracked.agent ??= text(event.data?.["agent"]);
        tracked.rejected = text(event.data?.["error"]) ?? "rejected";
      }
      continue;
    }
    if (event.job === "ask") {
      if (requestId !== undefined && event.run.startsWith(ASK_RUN_PREFIX)) {
        const tracked = open(requestId);
        tracked.agent = event.component;
        tracked.requestedAt = event.at;
      }
      continue;
    }
    const tag = text(event.data?.["_tag"]);
    const key = `${event.component} ${event.run}`;
    if (tag === "job.started") {
      const started = requestId ?? text(record(event.data?.["input"])?.["requestId"]);
      const tracked = started === undefined ? undefined : byRequest.get(started);
      if (tracked !== undefined) {
        tracked.agent ??= event.component;
        // A retry on the backup model starts the same run again: its start replaces the first.
        const model = text(event.data?.["model"]);
        const thinking = text(event.data?.["thinking"]);
        tracked.started = {
          at: event.at,
          ...(model === undefined ? {} : { model }),
          ...(thinking === undefined ? {} : { thinking }),
          ...(text(event.data?.["fellBackFrom"]) === undefined ? {} : { fellBack: true }),
        };
        byRun.set(key, tracked);
      }
      continue;
    }
    const tracked = byRun.get(key);
    if (tracked === undefined) continue;
    if (tag === "job.succeeded") {
      const seconds = event.data?.["seconds"];
      tracked.finished = {
        ok: true,
        seconds: typeof seconds === "number" ? seconds : undefined,
        error: undefined,
      };
    } else if (tag === "job.failed") {
      const seconds = event.data?.["seconds"];
      tracked.finished = {
        ok: false,
        seconds: typeof seconds === "number" ? seconds : undefined,
        error: text(event.data?.["message"]),
      };
    } else if (
      tag === undefined &&
      requestId !== undefined &&
      byRequest.get(requestId) === tracked
    ) {
      tracked.replied = true;
    }
  }
  const out: AgentRun[] = [];
  for (const [run, t] of byRequest) {
    if (t.agent === undefined) continue;
    const at = Date.parse(t.requestedAt ?? t.started?.at ?? "");
    const failure =
      t.rejected ??
      (!t.replied && t.finished?.ok === false ? (t.finished.error ?? "the run failed") : undefined);
    const done = t.replied || t.finished?.ok === true;
    const seconds = t.finished?.seconds;
    out.push({
      run,
      agent: t.agent,
      status: failure !== undefined ? "failed" : done ? "done" : "running",
      ...(Number.isNaN(at) ? {} : { startedAt: at }),
      ...(seconds === undefined ? {} : { seconds }),
      ...(failure === undefined ? {} : { error: failure.slice(0, 4000) }),
      ...(t.started?.model === undefined ? {} : { model: t.started.model }),
      ...(t.started?.thinking === undefined ? {} : { thinking: t.started.thinking }),
      ...(t.started?.fellBack === true ? { fellBack: true } : {}),
    });
  }
  return out;
}

/**
 * `runs` with their trial badges (trials/book.ts): the default arm's run takes its letter and the trial's other
 * arms follow it as their own runs (`trial:<trialId>:<letter>`); a run of an agent that switched its model
 * within TRIAL_SWITCH_BADGE_MS before it started names the new model. Arm runs already there are drawn again.
 */
function badgeTrialRuns(runs: readonly AgentRun[], badges: TrialBadges): AgentRun[] {
  const out: AgentRun[] = [];
  for (const r of runs) {
    if (r.run?.startsWith("trial:") === true) continue;
    const trial = r.run === undefined ? undefined : badges.byRequest.get(r.run);
    if (trial !== undefined) {
      // Blind until Isaac picks: the default arm's own run shows its letter and no model.
      const { model: _m, thinking: _t, fellBack: _f, ...own } = r;
      const shown = trial.picked ? r : own;
      out.push(shown.trial === trial.letter ? shown : { ...shown, trial: trial.letter });
      for (const arm of trial.others) {
        out.push({
          run: `trial:${trial.trialId}:${arm.letter}`,
          agent: r.agent,
          status: arm.status,
          trial: arm.letter,
          ...(arm.startedAt === undefined ? {} : { startedAt: arm.startedAt }),
          ...(arm.seconds === undefined ? {} : { seconds: arm.seconds }),
          ...(trial.picked && arm.model !== undefined ? { model: arm.model } : {}),
        });
      }
      continue;
    }
    const switched = badges.switched.get(r.agent);
    const fresh =
      switched !== undefined &&
      r.startedAt !== undefined &&
      r.startedAt >= switched.at &&
      r.startedAt - switched.at < TRIAL_SWITCH_BADGE_MS;
    out.push(!fresh || r.newModel === switched.toLabel ? r : { ...r, newModel: switched.toLabel });
  }
  return out;
}

/**
 * A thread's rows with every running specialist badge settled against the service's `runs` (`settleAgentRuns`):
 * the rows' `agents` take the service's state, and a status row's caption words it. `trials` adds the trial
 * letters and switched models to the badges (`badgeTrialRuns`). Rows nothing changed on are the same objects.
 * `runs` null (no service here) leaves the thread as the transcript shows it.
 */
export function settleAssistantMessages(
  messages: readonly AssistantMessage[],
  runs: readonly AgentRun[] | null,
  now: number,
  trials: TrialBadges | null = null,
): AssistantMessage[] {
  if (runs === null) return [...messages];
  return messages.map((message) => {
    const agents = message.agents;
    if (agents === undefined || agents.length === 0) return message;
    const settledRuns = agents.some((r) => r.status === "running")
      ? settleAgentRuns(agents, { runs, now })
      : agents;
    // A finished run keeps its row; the model it ran on comes from the service whenever it lists the run.
    const byRun = new Map(runs.flatMap((s) => (s.run === undefined ? [] : [[s.run, s] as const])));
    const settled = settledRuns.map((r) => {
      const s = r.run === undefined ? undefined : byRun.get(r.run);
      if (s?.model === undefined) return r;
      const { thinking: _t, fellBack: _f, ...rest } = r;
      return {
        ...rest,
        model: s.model,
        ...(s.thinking === undefined ? {} : { thinking: s.thinking }),
        ...(s.fellBack === true ? { fellBack: true } : {}),
      };
    });
    const moved = settled.some((r, i) => r.status !== agents[i]?.status);
    const badged = trials === null ? settled : badgeTrialRuns(settled, trials);
    const same =
      badged.length === agents.length &&
      badged.every((r, i) => {
        const was = agents[i];
        return (
          was !== undefined &&
          r.run === was.run &&
          r.status === was.status &&
          r.trial === was.trial &&
          r.newModel === was.newModel &&
          r.model === was.model &&
          r.thinking === was.thinking &&
          r.fellBack === was.fellBack
        );
      });
    if (same) return message;
    return {
      ...message,
      agents: badged,
      // The caption words the thread's own runs; the trial's other arms only show as badges.
      ...(message.role === "status" && moved ? { text: agentsCaption(settled, now) } : {}),
    };
  });
}

/**
 * The service's runs as of the journal's last write, re-read when its size or time moved; `null` while
 * the service has no journal here. `onChange` hears when a run appeared or changed state (a burst settles
 * for one poll), so open threads redraw their badges.
 */
export class SpecialistRunBook {
  private readonly journal: string;
  private stamp = "";
  private runs: AgentRun[] | null = null;
  private trialsFold: TrialsFold | null = null;
  private signature = "";
  private reading: Promise<AgentRun[] | null> | null = null;
  private readonly listeners = new Set<() => void>();
  private watching = false;
  private ticker: NodeJS.Timeout | undefined;

  constructor(
    home: string,
    private readonly pollMs = JOURNAL_POLL_MS,
    private readonly tickMs = TICK_MS,
  ) {
    this.journal = join(home, "events.ndjson");
  }

  /** The runs now: the cached fold while the journal is as it was, else a fresh read; a run still out past its time limit reads failed. */
  async current(): Promise<AgentRun[] | null> {
    if (!existsSync(this.journal)) return null;
    const stat = statSync(this.journal);
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (stamp !== this.stamp || this.runs === null) {
      this.reading ??= this.read(stamp).finally(() => {
        this.reading = null;
      });
      await this.reading;
    }
    return this.runs === null ? null : expireAgentRuns(this.runs, Date.now());
  }

  private async read(stamp: string): Promise<AgentRun[] | null> {
    let raw: string;
    try {
      raw = await readFile(this.journal, "utf8");
    } catch {
      return null;
    }
    const lines = raw.split("\n");
    this.runs = specialistRunsOfJournal(lines);
    this.trialsFold = trialsOfJournal(lines, Date.now());
    this.stamp = stamp;
    return this.runs;
  }

  /** The trial cards, switches and badges of the last read (`current`); empty before one or while the service has no journal. */
  trials(): TrialsFold {
    return this.trialsFold ?? EMPTY_TRIALS_FOLD;
  }

  /** Reads the journal and tells the listeners when a run or a trial appeared or changed state since they were last told. */
  async notify(): Promise<void> {
    const runs = await this.current();
    if (runs === null) return;
    const signature = `${runs.map((r) => `${r.run ?? ""}=${r.status}`).join(",")}#${trialsSignature(this.trials())}`;
    if (signature === this.signature) return;
    this.signature = signature;
    for (const heard of this.listeners) heard();
  }

  /**
   * Calls `listener` when the folded runs change (`notify`, on each journal write and every `tickMs`, which is how a run
   * the service lost expires with no write to wake it); starts watching with the first. Returns what stops it.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.watching) {
      this.watching = true;
      watchFile(this.journal, { interval: this.pollMs, persistent: false }, () => {
        void this.notify();
      });
      this.ticker = setInterval(() => void this.notify(), this.tickMs);
      this.ticker.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.watching) {
        unwatchFile(this.journal);
        clearInterval(this.ticker);
        this.watching = false;
      }
    };
  }
}
