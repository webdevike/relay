// What the atomic-agents service recorded about specialist runs (`agents_ask`), read from its journal
// (`<home>/events.ndjson`, appended by the service; widgets/bus.ts has the same no-import rule): the
// host settles each assistant thread's running badges against it, so a run that finished while no one
// polled `agents_result` shows done. The fold follows packages/atomic-agents/src/core/Requests.ts
// `Tracker` (run.requested / run.rejected, an ask pair's request, job.started naming the request, then the
// run's job.succeeded / job.failed or an ask pair's reply); only what a badge needs.

import { existsSync, statSync, watchFile, unwatchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentsCaption, settleAgentRuns, type AgentRun, type AssistantMessage } from "@relay/protocol";

const RUN_REQUESTED = "atomic-agents/run.requested";
const RUN_REJECTED = "atomic-agents/run.rejected";
const ASK_RUN_PREFIX = "ask-";
/** How often the journal's size and time are read, and how long a burst of appends settles before listeners hear. */
const JOURNAL_POLL_MS = 1000;

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
  started: { readonly at: string } | undefined;
  finished: { readonly ok: boolean; readonly seconds: number | undefined; readonly error: string | undefined } | undefined;
  replied: boolean;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

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
      tracked = { agent: undefined, requestedAt: undefined, rejected: undefined, started: undefined, finished: undefined, replied: false };
      byRequest.set(requestId, tracked);
    }
    return tracked;
  };
  for (const line of lines) {
    if (!line.includes('"requestId"') && !line.includes("/job.succeeded") && !line.includes("/job.failed")) continue;
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
        tracked.started = { at: event.at };
        byRun.set(key, tracked);
      }
      continue;
    }
    const tracked = byRun.get(key);
    if (tracked === undefined) continue;
    if (tag === "job.succeeded") {
      const seconds = event.data?.["seconds"];
      tracked.finished = { ok: true, seconds: typeof seconds === "number" ? seconds : undefined, error: undefined };
    } else if (tag === "job.failed") {
      const seconds = event.data?.["seconds"];
      tracked.finished = {
        ok: false,
        seconds: typeof seconds === "number" ? seconds : undefined,
        error: text(event.data?.["message"]),
      };
    } else if (tag === undefined && requestId !== undefined && byRequest.get(requestId) === tracked) {
      tracked.replied = true;
    }
  }
  const out: AgentRun[] = [];
  for (const [run, t] of byRequest) {
    if (t.agent === undefined) continue;
    const at = Date.parse(t.requestedAt ?? t.started?.at ?? "");
    const failure = t.rejected ?? (!t.replied && t.finished?.ok === false ? (t.finished.error ?? "the run failed") : undefined);
    const done = t.replied || t.finished?.ok === true;
    const seconds = t.finished?.seconds;
    out.push({
      run,
      agent: t.agent,
      status: failure !== undefined ? "failed" : done ? "done" : "running",
      ...(Number.isNaN(at) ? {} : { startedAt: at }),
      ...(seconds === undefined ? {} : { seconds }),
      ...(failure === undefined ? {} : { error: failure.slice(0, 4000) }),
    });
  }
  return out;
}

/**
 * A thread's rows with every running specialist badge settled against the service's `runs` (`settleAgentRuns`):
 * the rows' `agents` take the service's state, and a status row's caption words it. Rows nothing changed on are
 * the same objects. `runs` null (no service here) leaves the thread as the transcript shows it.
 */
export function settleAssistantMessages(
  messages: readonly AssistantMessage[],
  runs: readonly AgentRun[] | null,
  now: number,
): AssistantMessage[] {
  if (runs === null) return [...messages];
  return messages.map((message) => {
    const agents = message.agents;
    if (!agents?.some((r) => r.status === "running")) return message;
    const settled = settleAgentRuns(agents, { runs, now });
    if (settled.every((r, i) => r.status === agents[i]?.status)) return message;
    return {
      ...message,
      agents: settled,
      ...(message.role === "status" ? { text: agentsCaption(settled, now) } : {}),
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
  private signature = "";
  private reading: Promise<AgentRun[] | null> | null = null;
  private readonly listeners = new Set<() => void>();
  private watching = false;

  constructor(
    home: string,
    private readonly pollMs = JOURNAL_POLL_MS,
  ) {
    this.journal = join(home, "events.ndjson");
  }

  /** The runs now: the cached fold while the journal is as it was, else a fresh read. */
  async current(): Promise<AgentRun[] | null> {
    if (!existsSync(this.journal)) return null;
    const stat = statSync(this.journal);
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (stamp === this.stamp && this.runs !== null) return this.runs;
    this.reading ??= this.read(stamp).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(stamp: string): Promise<AgentRun[] | null> {
    let raw: string;
    try {
      raw = await readFile(this.journal, "utf8");
    } catch {
      return null;
    }
    this.runs = specialistRunsOfJournal(raw.split("\n"));
    this.stamp = stamp;
    return this.runs;
  }

  /** Reads the journal and tells the listeners when a run appeared or changed state since they were last told. */
  async notify(): Promise<void> {
    const runs = await this.current();
    if (runs === null) return;
    const signature = runs.map((r) => `${r.run ?? ""}=${r.status}`).join(",");
    if (signature === this.signature) return;
    this.signature = signature;
    for (const heard of this.listeners) heard();
  }

  /** Calls `listener` when the folded runs change (`notify`, on each journal write); starts watching the journal with the first. Returns what stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.watching) {
      this.watching = true;
      watchFile(this.journal, { interval: this.pollMs, persistent: false }, () => {
        void this.notify();
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.watching) {
        unwatchFile(this.journal);
        this.watching = false;
      }
    };
  }
}
