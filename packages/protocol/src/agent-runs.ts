import { z } from "zod";

/**
 * Specialist agents in a chat: an assistant asks one through the `relay` MCP server's `agents_ask` (and reads a
 * long run back with `agents_result`, same run id). Eva's `.omp/tools/relay-mcp.ts` answers both with the run as
 * JSON (`atomic-agents request|result`, packages/atomic-agents/src/core/Requests.ts `RunStatus`). Every surface
 * that shows a transcript (desktop chat, the host's phone rows) turns those calls into `AgentRun`s here, folds them
 * per run, and shows them on the reply of the turn that used them: a badge in the margin and one caption line.
 */

/** One specialist run as a chat shows it. */
export const AgentRun = z.object({
  /** The run id (`agents_ask`'s answer, `agents_result`'s argument); absent while the first `agents_ask` call is out. */
  run: z.string().max(200).optional(),
  /** Agent id, e.g. `web-researcher`. */
  agent: z.string().min(1).max(200),
  status: z.enum(["running", "done", "failed"]),
  /** What the assistant asked (the agent's request fields). */
  request: z.unknown().optional(),
  /** The agent's typed reply, without its bookkeeping (`REPLY_STATS`). */
  reply: z.unknown().optional(),
  /** The reply's one-text answer, when the agent has one. */
  text: z.string().max(20_000).optional(),
  error: z.string().max(4000).optional(),
  /** When the ask started (ms), for the running clock. */
  startedAt: z.number().optional(),
  seconds: z.number().optional(),
  /** USD, when the agent reports it. */
  cost: z.number().optional(),
  /** Verified citations in the reply. */
  sources: z.number().int().optional(),
  /** A trial run's letter (packages/protocol trials.ts): its badge reads `Diagram B`, never the model. */
  trial: z.enum(["A", "B", "C"]).optional().catch(undefined),
  /** The short name of the model the agent switched to on its own, for a while after the switch (`TRIAL_SWITCH_BADGE_MS`): its badge reads `Diagram · Sonnet 5.5`. */
  newModel: z.string().max(200).optional().catch(undefined),
  /** The model id the run is on (the service's `job.started`); absent for a trial arm until Isaac picks, and until the service lists the run. */
  model: z.string().max(200).optional().catch(undefined),
  /** The thinking level its agent was set to for the run, when it had one. */
  thinking: z.string().max(40).optional().catch(undefined),
  /** The run is on the agent's backup model: the main one failed first. */
  fellBack: z.boolean().optional().catch(undefined),
});
export type AgentRun = z.infer<typeof AgentRun>;

const idWords = (text: string): string[] =>
  text
    .split(/[-_\s]+/)
    .filter((word) => word !== "" && !/^\d{8}$/.test(word))
    .reduce<string[]>((out, word) => {
      const last = out[out.length - 1];
      // `5-5` is version 5.5: a number after a whole number joins it.
      if (/^\d+$/.test(word) && last !== undefined && /^\d+$/.test(last))
        out[out.length - 1] = `${last}.${word}`;
      else out.push(word);
      return out;
    }, []);

/** A model id as Isaac reads it: `anthropic/claude-haiku-5-5` → `Claude Haiku 5.5`, `openrouter/moonshotai/kimi-k3.1-pro` → `Kimi K3.1 Pro`, `openai/gpt-6.1-sol` → `GPT-6.1 Sol`. */
export function modelName(model: string): string {
  const words = idWords(model.split("/").pop() ?? model);
  const cap = (w: string): string =>
    /^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  if (words[0]?.toLowerCase() === "gpt" && words[1] !== undefined)
    return [`GPT-${words[1]}`, ...words.slice(2).map(cap)].join(" ");
  return words.map(cap).join(" ");
}

/**
 * The Model row of a run's details: `Claude Haiku 5.5 · high thinking`, with `(backup)` after the name when the run
 * fell back to the agent's backup model (`Kimi K3.1 Pro (backup)`). Null while no model is known, which is also how a
 * trial arm stays blind: its run carries no model until Isaac picks.
 */
export function agentModelLine(
  run: Pick<AgentRun, "model" | "thinking" | "fellBack">,
): string | null {
  if (run.model === undefined || run.model.trim() === "") return null;
  const name = `${modelName(run.model)}${run.fellBack === true ? " (backup)" : ""}`;
  return run.thinking === undefined || run.thinking === "off"
    ? name
    : `${name} · ${run.thinking} thinking`;
}

export type AgentTool = "agents_ask" | "agents_result";

/** An `agents_ask` or `agents_result` call, from its tool name and arguments. */
export interface AgentCall {
  readonly tool: AgentTool;
  readonly agent?: string;
  readonly run?: string;
  readonly request?: unknown;
}

const TOOL = /(?:^|_)(agents_ask|agents_result)$/;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** `agents_ask {agent, request, timeoutMs?}` / `agents_result {run, timeoutMs?}` arguments. */
const CallArgs = z.object({
  agent: z.string().min(1).optional(),
  run: z.string().min(1).optional(),
  request: z.unknown().optional(),
});
/** omp's xd device call: `write` to `xd://<tool>` with the tool's arguments as JSON text. */
const XdWrite = z.object({ path: z.string(), content: z.unknown().optional() });

/**
 * The call when `name`/`args` is one: the MCP tool by name (`mcp__relay_agents_ask`, `relay_agents_ask`, `agents_ask`),
 * or omp's xd device write (`write` to `xd://mcp__relay_agents_ask`, the arguments as JSON in `content`).
 */
export function agentCallOf(name: string, args: unknown): AgentCall | undefined {
  let tool = TOOL.exec(name)?.[1];
  let input = args;
  if (tool === undefined && name === "write") {
    const xd = XdWrite.safeParse(args);
    if (!xd.success || !xd.data.path.startsWith("xd://")) return undefined;
    tool = TOOL.exec(xd.data.path.slice(5))?.[1];
    input = typeof xd.data.content === "string" ? parseJson(xd.data.content) : xd.data.content;
  }
  if (tool === undefined) return undefined;
  const parsed = CallArgs.safeParse(input);
  const { agent, run, request } = parsed.success ? parsed.data : {};
  return {
    tool: tool as AgentTool,
    ...(agent === undefined ? {} : { agent }),
    ...(run === undefined ? {} : { run }),
    ...(request === undefined ? {} : { request }),
  };
}

/** A run as relay-mcp answers it (atomic-agents `RunStatus`). */
const RunStatus = z.object({
  agent: z.string().min(1),
  run: z.string().min(1).optional(),
  status: z.enum(["running", "done", "failed"]),
  request: z.unknown().optional(),
  reply: z.unknown().optional(),
  text: z.string().optional(),
  error: z.string().optional(),
  requestedAt: z.string().optional(),
  startedAt: z.string().optional(),
  seconds: z.number().optional(),
  cost: z.number().optional(),
});
/** A refused call: `{error, schema?}` (no such agent, a request its schema rejects). */
const Refused = z.object({ error: z.string().min(1) });
/** A reply's citations, when it has them (web-researcher). */
const Cited = z
  .object({ citations: z.array(z.object({ verified: z.boolean().optional() }).passthrough()) })
  .passthrough();

/** Reply fields the run reports apart (`seconds`, `cost`, `model`) or that only the agent's own bench reads. */
const REPLY_STATS = ["requestId", "toolCalls", "route", "model", "attempts", "cost", "seconds"];

const time = (iso: string | undefined): number | undefined => {
  const at = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(at) ? undefined : at;
};

/**
 * The run a call shows: `result` is the tool result (its text and whether it failed), absent while the call runs;
 * `startedAt` is when the call started (ms). An `agents_result` call still out says nothing new (undefined).
 */
export function agentRunOf(
  call: AgentCall,
  result?: { readonly text: string | null; readonly isError: boolean },
  startedAt?: number,
): AgentRun | undefined {
  const at = startedAt === undefined ? {} : { startedAt };
  const asked = call.request === undefined ? {} : { request: call.request };
  if (result === undefined || result.text === null) {
    if (call.tool === "agents_result" || call.agent === undefined) return undefined;
    return { agent: call.agent, status: "running", ...asked, ...at };
  }
  const raw = result.text.replace(/^Error:\s*/, "").trim();
  const json = parseJson(raw);
  const status = RunStatus.safeParse(json);
  if (result.isError || !status.success) {
    const agent = call.agent;
    if (agent === undefined) return undefined;
    const refused = Refused.safeParse(json);
    const error = refused.success
      ? refused.data.error
      : raw.replace(/^error:\s*/, "") || "the call failed";
    return {
      agent,
      status: "failed",
      ...(call.run === undefined ? {} : { run: call.run }),
      ...asked,
      error: error.slice(0, 4000),
      ...at,
    };
  }
  const value = status.data;
  const cited = Cited.safeParse(value.reply);
  const fields = z.record(z.unknown()).safeParse(value.reply);
  const trimmed = fields.success
    ? Object.fromEntries(Object.entries(fields.data).filter(([key]) => !REPLY_STATS.includes(key)))
    : value.reply;
  const run = value.run ?? call.run;
  const request = value.request ?? call.request;
  const began = time(value.requestedAt) ?? time(value.startedAt) ?? startedAt;
  return {
    agent: value.agent,
    status: value.status,
    ...(run === undefined ? {} : { run }),
    ...(request === undefined ? {} : { request }),
    ...(trimmed === undefined ? {} : { reply: trimmed }),
    ...(value.text === undefined ? {} : { text: value.text.slice(0, 20_000) }),
    ...(value.error === undefined ? {} : { error: value.error.slice(0, 4000) }),
    ...(began === undefined ? {} : { startedAt: began }),
    ...(value.seconds === undefined ? {} : { seconds: value.seconds }),
    ...(value.cost === undefined ? {} : { cost: value.cost }),
    ...(cited.success
      ? { sources: cited.data.citations.filter((c) => c.verified === true).length }
      : {}),
  };
}

/** One run per run id (an `agents_ask` that came back running, then the `agents_result` that finished it): the latest state, in first-seen order, keeping the first start time. */
export function foldAgentRuns(runs: readonly AgentRun[]): AgentRun[] {
  const out: AgentRun[] = [];
  const byRun = new Map<string, number>();
  for (const r of runs) {
    const at = r.run === undefined ? undefined : byRun.get(r.run);
    if (at === undefined) {
      if (r.run !== undefined) byRun.set(r.run, out.length);
      out.push(r);
      continue;
    }
    const first = out[at]!;
    const startedAt = first.startedAt ?? r.startedAt;
    out[at] = { ...first, ...r, ...(startedAt === undefined ? {} : { startedAt }) };
  }
  return out;
}

/** `web-researcher` → `Web researcher`. */
export function agentLabel(agent: string): string {
  const words = agent.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `0:07` while running, `29s` / `2m 14s` when done. */
export function agentClock(ms: number, running: boolean): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (running) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const finished = (r: AgentRun): boolean => r.status !== "running";

/** `b` laid over `a` (same run): a finished state never goes back to running (a service snapshot older than the transcript, or the other way round). */
function overlay(a: AgentRun, b: AgentRun): AgentRun {
  if (finished(a) && !finished(b)) return { ...b, ...a };
  const startedAt = b.startedAt ?? a.startedAt;
  return { ...a, ...b, ...(startedAt === undefined ? {} : { startedAt }) };
}

/**
 * A chat's specialist runs as its live badges, newest first. `transcript` is every agents call the
 * chat's transcript shows (folded per run id); `service` is what the atomic-agents service recorded
 * for this chat as caller (`atomic-agents runs`), which finishes a run whose `agents_ask` came back
 * running and lists runs asked outside an agents call. A service run joins its transcript run by run
 * id, else the transcript's running ask of the same agent still waiting for its id; the rest are added.
 * Running, then done or failed; never back.
 */
export function liveAgentRuns(
  transcript: readonly AgentRun[],
  service: readonly AgentRun[] = [],
): AgentRun[] {
  const out = foldAgentRuns(transcript);
  for (const s of service) {
    let at = s.run === undefined ? -1 : out.findIndex((r) => r.run === s.run);
    if (at < 0)
      at = out.findIndex(
        (r) => r.run === undefined && r.agent === s.agent && r.status === "running",
      );
    if (at < 0) out.push(s);
    else out[at] = overlay(out[at]!, s);
  }
  // Newest first; a run with no start time is the one just asked.
  const start = (r: AgentRun): number => r.startedAt ?? Number.POSITIVE_INFINITY;
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => start(b.r) - start(a.r) || b.i - a.i)
    .map(({ r }) => r);
}

/** An ask that has no run id this long after it started never reached the service (a blocking ask returns well inside it). */
export const AGENT_UNRECORDED_MS = 10 * 60_000;
/**
 * The longest a specialist run lives: the deepest tier's budget (900 s) plus a grace. A run still `running` past it was lost
 * (the service restarted under it, its end never reached the journal), so its badge reads failed instead of counting on.
 */
export const AGENT_RUN_MAX_MS = 20 * 60_000;

/** What the atomic-agents service recorded, as a whole (every caller's runs), to settle a chat's running badges against. */
export interface AgentSnapshot {
  readonly runs: readonly AgentRun[];
  readonly now: number;
  /** The snapshot holds every run asked at or after this (ms); an older run it cannot judge. Absent: it holds them all. */
  readonly since?: number;
}

/** A badge still `running` past `AGENT_RUN_MAX_MS` after it started, as failed; every other run as it is (the same objects). */
export function expireAgentRuns(runs: readonly AgentRun[], now: number): AgentRun[] {
  return runs.map((r) =>
    r.status === "running" && r.startedAt !== undefined && now - r.startedAt > AGENT_RUN_MAX_MS
      ? { ...r, status: "failed" as const, error: "The run outlived its time limit" }
      : r,
  );
}

/**
 * A badge still `running` against the service's record: the service's state when it knows the run (so a run that finished while
 * nobody polled `agents_result` reads done or failed), failed when it does not (a run id the service never recorded, or an ask that
 * got no id within `AGENT_UNRECORDED_MS`). Finished badges stay as they are; a run older than the snapshot reaches stays running
 * until `AGENT_RUN_MAX_MS` expires it, as it does a run the service itself still lists as running.
 */
export function settleAgentRuns(runs: readonly AgentRun[], snapshot: AgentSnapshot): AgentRun[] {
  const byId = new Map<string, AgentRun>();
  for (const s of snapshot.runs) if (s.run !== undefined) byId.set(s.run, s);
  const settled = runs.map((r) => {
    if (finished(r)) return r;
    const known = r.run === undefined ? undefined : byId.get(r.run);
    if (known !== undefined) return overlay(r, known);
    if (r.run === undefined) {
      if (r.startedAt === undefined || snapshot.now - r.startedAt < AGENT_UNRECORDED_MS) return r;
    } else if (
      snapshot.since !== undefined &&
      (r.startedAt === undefined || r.startedAt < snapshot.since)
    ) {
      return r;
    }
    return {
      ...r,
      status: "failed" as const,
      error: "The specialist service has no record of this run",
    };
  });
  return expireAgentRuns(settled, snapshot.now);
}

/** A finished badge stays this long after its run ended; a run still "running" this long after it started is stale (its end never reached the chat). */
export const AGENT_BADGE_LINGER_MS = 30 * 60_000;
export const AGENT_BADGE_STALE_MS = 60 * 60_000;

/**
 * The badges a chat shows now: runs still out (unless stale), and runs that ended in the last
 * `AGENT_BADGE_LINGER_MS` (end = start + seconds). A run with no start time is one just asked.
 */
export function recentAgentRuns(runs: readonly AgentRun[], now: number): AgentRun[] {
  return runs.filter((r) => {
    if (r.startedAt === undefined) return r.status === "running";
    if (r.status === "running") return now - r.startedAt < AGENT_BADGE_STALE_MS;
    return now - (r.startedAt + (r.seconds ?? 0) * 1000) < AGENT_BADGE_LINGER_MS;
  });
}

/** What a run's badge says: its state, the specialist's name (with its trial letter, or the model it just switched to), and its clock (`0:12` ticking while it runs, `29s` once it ended; null when unknown). */
export interface AgentBadge {
  readonly state: AgentRun["status"];
  readonly label: string;
  readonly clock: string | null;
}

export function agentBadge(run: AgentRun, now: number): AgentBadge {
  const clock =
    run.status === "running"
      ? agentClock(run.startedAt === undefined ? 0 : now - run.startedAt, true)
      : run.seconds === undefined
        ? null
        : agentClock(run.seconds * 1000, false);
  const name = agentLabel(run.agent);
  const label =
    run.trial !== undefined
      ? `${name} ${run.trial}`
      : run.newModel !== undefined
        ? `${name} · ${run.newModel}`
        : name;
  return { state: run.status, label, clock };
}

/** The key a badge is cleared (Clear done) and listed by: its run id, else its agent and start. */
export function agentRunKey(run: AgentRun): string {
  return run.run ?? `${run.agent}@${run.startedAt ?? ""}`;
}

const list = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * The one caption line under a reply. Running: `Web researcher is on it · 0:12`. Done: `Answered with Web researcher · 29s · 3 sources`.
 * Several: `Answered with Web researcher and Design critic · 47s · 3 sources`. A failed run: `Web researcher failed`.
 */
export function agentsCaption(runs: readonly AgentRun[], now: number): string {
  const running = runs.filter((r) => r.status === "running");
  if (running.length > 0) {
    const since = Math.min(...running.map((r) => r.startedAt ?? now));
    const names = list(running.map((r) => agentLabel(r.agent)));
    return `${names} ${running.length === 1 ? "is" : "are"} on it · ${agentClock(now - since, true)}`;
  }
  const done = runs.filter((r) => r.status === "done");
  const failed = runs.filter((r) => r.status === "failed");
  const parts: string[] = [];
  if (done.length > 0) {
    const seconds = done.reduce((sum, r) => sum + (r.seconds ?? 0), 0);
    const sources = done.reduce((sum, r) => sum + (r.sources ?? 0), 0);
    parts.push(`Answered with ${list(done.map((r) => agentLabel(r.agent)))}`);
    if (seconds > 0) parts.push(agentClock(seconds * 1000, false));
    if (sources > 0) parts.push(`${sources} source${sources === 1 ? "" : "s"}`);
  }
  if (failed.length > 0) parts.push(`${list(failed.map((r) => agentLabel(r.agent)))} failed`);
  return parts.join(" · ");
}

/**
 * Where each turn's specialist runs show. `kind` reads a row: `user` starts a turn, `reply` is an assistant reply,
 * a run is a row carrying one (an agents call). Each turn's runs are folded and keyed by the index of the turn's
 * last reply, else (no reply yet) of its last run row. A run shows its latest state everywhere: an ask left running
 * in one turn and finished by `agents_result` in a later one reads done in both.
 */
export function agentRunsByRow<T>(
  rows: readonly T[],
  kind: (row: T) => "user" | "reply" | AgentRun | undefined,
): Map<number, AgentRun[]> {
  const kinds = rows.map(kind);
  const latest = new Map<string, AgentRun>();
  for (const r of foldAgentRuns(kinds.filter((k): k is AgentRun => typeof k === "object"))) {
    if (r.run !== undefined) latest.set(r.run, r);
  }
  const out = new Map<number, AgentRun[]>();
  let runs: AgentRun[] = [];
  let reply = -1;
  let lastRun = -1;
  const close = () => {
    const at = reply >= 0 ? reply : lastRun;
    if (runs.length > 0 && at >= 0) {
      out.set(
        at,
        foldAgentRuns(runs).map((r) => (r.run === undefined ? r : (latest.get(r.run) ?? r))),
      );
    }
    runs = [];
    reply = -1;
    lastRun = -1;
  };
  kinds.forEach((k, i) => {
    if (k === "user") close();
    else if (k === "reply") reply = i;
    else if (k !== undefined) {
      runs.push(k);
      lastRun = i;
    }
  });
  close();
  return out;
}
