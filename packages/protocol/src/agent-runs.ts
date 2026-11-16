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
});
export type AgentRun = z.infer<typeof AgentRun>;

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
 * last reply, else (no reply yet) of its last run row.
 */
export function agentRunsByRow<T>(
  rows: readonly T[],
  kind: (row: T) => "user" | "reply" | AgentRun | undefined,
): Map<number, AgentRun[]> {
  const out = new Map<number, AgentRun[]>();
  let runs: AgentRun[] = [];
  let reply = -1;
  let lastRun = -1;
  const close = () => {
    const at = reply >= 0 ? reply : lastRun;
    if (runs.length > 0 && at >= 0) out.set(at, foldAgentRuns(runs));
    runs = [];
    reply = -1;
    lastRun = -1;
  };
  rows.forEach((row, i) => {
    const k = kind(row);
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
