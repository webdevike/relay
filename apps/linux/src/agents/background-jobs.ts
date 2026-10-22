// Tracks the async jobs an omp session leaves running (`bg_N` bash commands, eval cells) from the
// messages it produces, the way EvaOS reads them from the session file (apps/evaos/src/chat.rs,
// `background_jobs`). Used by the relay-bridge omp extension, which imports it by relative path
// under omp's bun, so this file may only use node built-ins (no zod, no @relay/protocol).
//
// A tool result whose `details.async.state` is "running" starts a job (its `jobId` and `type`).
// It ends on an async-result delivery (`details.jobs[]` entries with `jobId`), a `wait` snapshot
// (`details.jobs[]` entries with `id` and a `status` other than "running"), or a proc:// cancel or
// kill (`details.proc.jobs[]`). Subagent (`task`) jobs are left out: they are mirrored as sessions.

export type BackgroundJobState = "running" | "done" | "failed" | "cancelled";

/** Mirrors `AgentBackgroundJob` in @relay/protocol. */
export interface BackgroundJob {
  id: string;
  type: string;
  label: string;
  state: BackgroundJobState;
  startedAt: number;
}

/** An ended job stays listed this long, so the phone can show how it finished. */
export const ENDED_JOB_LINGER_MS = 60_000;
/** Tool-call labels remembered while their results are pending; older ones are dropped first. */
const MAX_PENDING_LABELS = 200;
const MAX_LABEL = 160;

/** The parts of omp's tool-result and delivery `details` that start or end a job; every field is checked before use. */
interface JobDetails {
  async?: { state?: unknown; jobId?: unknown; type?: unknown } | null;
  jobs?: unknown;
  proc?: { jobs?: unknown } | null;
}

/** One `details.jobs[]` / `details.proc.jobs[]` entry: a delivery (`jobId`) or a snapshot row (`id`, `status`). */
interface JobEntry {
  jobId?: unknown;
  id?: unknown;
  status?: unknown;
}

/** The job a tool result's details start, as its id and omp's job type; null for anything else. */
export function jobStarted(details: unknown): { id: string; type: string } | null {
  if (typeof details !== "object" || details === null) return null;
  const started = (details as JobDetails).async;
  if (typeof started !== "object" || started === null) return null;
  if (started.state !== "running" || typeof started.jobId !== "string" || started.jobId.length === 0) return null;
  const type = typeof started.type === "string" && started.type.length > 0 ? started.type : "job";
  return type === "task" ? null : { id: started.jobId, type };
}

/** How a finished job's `status` reads on the phone; a delivery without one completed. */
function endedState(status: unknown): Exclude<BackgroundJobState, "running"> {
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled" || status === "killed" || status === "aborted") return "cancelled";
  return "done";
}

/** The jobs a message's details report finished, with how each ended. */
export function jobsEnded(details: unknown): { id: string; state: Exclude<BackgroundJobState, "running"> }[] {
  if (typeof details !== "object" || details === null) return [];
  const { jobs, proc } = details as JobDetails;
  const lists = [jobs, typeof proc === "object" && proc !== null ? proc.jobs : undefined];
  const ended: { id: string; state: Exclude<BackgroundJobState, "running"> }[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const job = entry as JobEntry;
      if (typeof job.jobId === "string") {
        ended.push({ id: job.jobId, state: endedState(job.status) });
      } else if (typeof job.id === "string" && job.status !== "running") {
        ended.push({ id: job.id, state: endedState(job.status) });
      }
    }
  }
  return ended;
}

/** One line of what a tool call runs: bash's command, an eval cell's title or first code line. */
export function jobLabel(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const { command, title, code } = args as { command?: unknown; title?: unknown; code?: unknown };
  for (const value of [command, title, code]) {
    if (typeof value !== "string") continue;
    const line = value.trim().split("\n", 1)[0]?.trim() ?? "";
    if (line.length > 0) return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line;
  }
  return undefined;
}

/** A session's background jobs, fed every finished message. */
export class BackgroundJobs {
  private readonly jobs = new Map<string, BackgroundJob & { endedAt?: number }>();
  /** Labels of tool calls whose results have not arrived yet, by tool call id. */
  private readonly labels = new Map<string, string>();

  /** Remembers what a tool call runs, for the job its result may start. */
  noteToolCall(toolCallId: string, args: unknown): void {
    const label = jobLabel(args);
    if (label === undefined) return;
    this.labels.set(toolCallId, label);
    if (this.labels.size > MAX_PENDING_LABELS) {
      const oldest = this.labels.keys().next();
      if (oldest.done !== true) this.labels.delete(oldest.value);
    }
  }

  /**
   * Applies one finished message (a tool result or a custom delivery); true when the list
   * changed. `at` is the message's timestamp, the start time of a job it starts.
   */
  apply(message: { toolCallId?: unknown; details?: unknown }, at: number): boolean {
    let changed = false;
    const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    const label = callId === undefined ? undefined : this.labels.get(callId);
    if (callId !== undefined) this.labels.delete(callId);
    const started = jobStarted(message.details);
    if (started !== null) {
      this.jobs.delete(started.id);
      this.jobs.set(started.id, { id: started.id, type: started.type, label: label ?? started.id, state: "running", startedAt: at });
      changed = true;
    }
    for (const ended of jobsEnded(message.details)) {
      const job = this.jobs.get(ended.id);
      if (job?.state !== "running") continue;
      job.state = ended.state;
      job.endedAt = at;
      changed = true;
    }
    return changed;
  }

  /** Running jobs and the ones that ended within the linger, oldest first; expired ones are dropped. */
  list(now: number): BackgroundJob[] {
    const shown: BackgroundJob[] = [];
    for (const [id, job] of this.jobs) {
      if (job.endedAt !== undefined && now - job.endedAt >= ENDED_JOB_LINGER_MS) {
        this.jobs.delete(id);
        continue;
      }
      shown.push({ id: job.id, type: job.type, label: job.label, state: job.state, startedAt: job.startedAt });
    }
    return shown;
  }

  clear(): void {
    this.jobs.clear();
    this.labels.clear();
  }
}
