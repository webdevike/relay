import { Clock, Cron, Effect, Result } from "effect";
import { Agents } from "../Agent.ts";
import { Trigger } from "../Component.ts";
import { Home } from "../Event.ts";
import { countedOn } from "../InstallGate.ts";
import type { Mode } from "../RuntimeEvents.ts";
import { GRACE_MS, type MissedReason, ticksBetween } from "../Scheduler.ts";
import { effective, Settings } from "../Settings.ts";
import { SPAN } from "./Spans.ts";
import * as Traces from "./Traces.ts";

/**
 * `atomic-agents health`: per agent over a window, from the trace files and config.json. Runs (last, count, failures,
 * fallbacks), each cron job's ticks (expected from its expression, ran, missed by reason, and unaccounted: neither run
 * nor recorded missed, so the service was not running or not this version yet), what consumers did with requested runs
 * (`Traces.outcomeOf`), and whether the service's newest roster check found it missing.
 */

export interface CronHealth {
  readonly job: string;
  readonly cron: string;
  readonly expected: number;
  readonly ran: number;
  readonly missed: number;
  readonly reasons: Partial<Record<MissedReason, number>>;
  readonly unaccounted: number;
}

export interface AgentHealth {
  readonly agent: string;
  /** config.json `mode` when it is live or shadow and the agent is not disabled. */
  readonly mode?: Mode;
  /** Undefined when this process does not load the agent. */
  readonly enabled?: boolean;
  readonly lastRun?: {
    readonly at: string;
    readonly run: string;
    readonly ok: boolean;
    readonly trigger?: string;
  };
  readonly runs: number;
  readonly failures: number;
  readonly fallbacks: number;
  readonly crons: ReadonlyArray<CronHealth>;
  readonly outcomes: Partial<Record<Traces.TraceOutcome["value"], number>>;
  /** Why the service's newest roster check found it missing. */
  readonly missing?: string;
}

export interface Health {
  readonly since: string;
  readonly now: string;
  /** Cron ticks are counted from here: the window's start, or the first roster check when that is later. */
  readonly ticksSince: string;
  /** The service's newest `roster.check` (it records one at start and on every change). */
  readonly roster?: {
    readonly at: string;
    readonly loaded: number;
    readonly missing: ReadonlyArray<{ readonly id: string; readonly why: string }>;
  };
  readonly agents: ReadonlyArray<AgentHealth>;
}

export interface Scheduled {
  readonly id: string;
  readonly enabled: boolean;
  readonly crons: ReadonlyArray<{ readonly job: string; readonly cron: string }>;
}

const iso = (millis: number) => new Date(millis).toISOString();

const bump = <K extends string>(counts: Partial<Record<K, number>>, key: K, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

/**
 * The summary over `[since, now]`. `traces` is every trace kept (`Traces.query`, outcomes set): runs and missed ticks
 * count inside the window, the roster check is the newest one at all. `agents` are the agents loaded here with the crons
 * in force; `counted` what config.json counts on.
 */
export const summarize = (input: {
  readonly traces: ReadonlyArray<Traces.Trace>;
  readonly since: number;
  readonly now: number;
  readonly agents: ReadonlyArray<Scheduled>;
  readonly counted: ReadonlyArray<{ readonly id: string; readonly mode: Mode }>;
}): Health => {
  const { traces, since, now } = input;
  const inWindow = traces.filter((trace) => trace.root.start >= since);
  const runs = inWindow.filter((trace) => trace.root.name === SPAN.run);
  const missedTicks = inWindow.filter((trace) => trace.root.name === SPAN.missed);
  const rosterChecks = traces
    .filter((trace) => trace.root.name === SPAN.roster)
    .sort((a, b) => b.root.start - a.root.start);
  const rosterTrace = rosterChecks[0];
  // Ticks are accounted for since a service with the scheduler first ran (its first roster check): older cron runs
  // carry no `run.trigger`, so counting before that would call every one of them unaccounted.
  const ticksFrom = Math.max(since, rosterChecks[rosterChecks.length - 1]?.root.start ?? now);
  const roster =
    rosterTrace === undefined
      ? undefined
      : {
          at: iso(rosterTrace.root.start),
          loaded: Number(rosterTrace.root.attributes["roster.loaded"] ?? 0),
          missing: rosterTrace.root.children
            .filter((child) => child.name === SPAN.rosterMissing)
            .map((child) => ({
              id: String(child.attributes["roster.agent"]),
              why: String(child.attributes["roster.why"] ?? ""),
            })),
        };

  const ids = [
    ...new Set([
      ...input.agents.map((agent) => agent.id),
      ...input.counted.map(({ id }) => id),
      ...runs.flatMap((trace) => {
        const id = trace.root.attributes["agent.id"];
        return typeof id === "string" ? [id] : [];
      }),
    ]),
  ].sort();

  const agents = ids.map((id): AgentHealth => {
    const own = runs
      .filter((trace) => trace.root.attributes["agent.id"] === id)
      .sort((a, b) => b.root.start - a.root.start);
    const newest = own[0];
    const scheduled = input.agents.find((agent) => agent.id === id);
    const outcomes: Partial<Record<Traces.TraceOutcome["value"], number>> = {};
    for (const trace of own) if (trace.outcome !== undefined) bump(outcomes, trace.outcome.value);
    // Expected, ran and missed all count the ticks in (ticksFrom, now - GRACE_MS]; a tick younger than that may still start.
    const inRange = (at: unknown) => Number(at) > ticksFrom && Number(at) <= now - GRACE_MS;
    const crons = (scheduled?.enabled === true ? scheduled.crons : []).map(({ job, cron }) => {
      const parsed = Cron.parse(cron);
      const expected = Result.isSuccess(parsed)
        ? ticksBetween(parsed.success, ticksFrom, now - GRACE_MS).length
        : 0;
      const ran = own.filter(
        ({ root }) =>
          root.attributes["run.trigger"] === "cron" &&
          root.attributes["agent.job"] === job &&
          inRange(root.attributes["schedule.expected"]),
      ).length;
      const reasons: Partial<Record<MissedReason, number>> = {};
      for (const { root } of missedTicks)
        if (
          root.attributes["agent.id"] === id &&
          root.attributes["agent.job"] === job &&
          inRange(root.attributes["schedule.expected"])
        )
          bump(
            reasons,
            String(root.attributes["schedule.reason"]) as MissedReason,
            Number(root.attributes["schedule.count"] ?? 1),
          );
      // A hung run still ran its tick; every other reason is a tick with no run.
      const missed = Object.entries(reasons)
        .filter(([reason]) => reason !== "hung")
        .reduce((sum, [, count]) => sum + (count ?? 0), 0);
      return {
        job,
        cron,
        expected,
        ran,
        missed,
        reasons,
        unaccounted: Math.max(0, expected - ran - missed),
      };
    });
    const counted = input.counted.find((entry) => entry.id === id);
    const missing = roster?.missing.find((entry) => entry.id === id)?.why;
    return {
      agent: id,
      ...(counted === undefined ? {} : { mode: counted.mode }),
      ...(scheduled === undefined ? {} : { enabled: scheduled.enabled }),
      ...(newest === undefined
        ? {}
        : {
            lastRun: {
              at: iso(newest.root.start),
              run: String(newest.root.attributes["agent.run"] ?? ""),
              ok: newest.root.error === undefined && !newest.open,
              ...(typeof newest.root.attributes["run.trigger"] === "string"
                ? { trigger: newest.root.attributes["run.trigger"] }
                : {}),
            },
          }),
      runs: own.length,
      failures: own.filter((trace) => trace.root.error !== undefined).length,
      fallbacks: own.filter((trace) => trace.root.attributes["run.fell_back"] === true).length,
      crons,
      outcomes,
      ...(missing === undefined ? {} : { missing }),
    };
  });
  return {
    since: iso(since),
    now: iso(now),
    ticksSince: iso(ticksFrom),
    ...(roster === undefined ? {} : { roster }),
    agents,
  };
};

/** The summary over the last `windowMs`, from `<home>/traces`, the agents this process loads and config.json. */
export const gather = (windowMs: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const config = yield* (yield* Settings).current;
    const agents = (yield* (yield* Agents).current).map((agent): Scheduled => {
      const resolved = effective(agent, config);
      return {
        id: agent.id,
        enabled: resolved.enabled,
        crons: agent.jobs.flatMap((job) =>
          job.triggers.flatMap((trigger) =>
            Trigger.$is("Cron")(trigger)
              ? [{ job: job.id, cron: resolved.cron(job.id, trigger.cron) }]
              : [],
          ),
        ),
      };
    });
    // Every trace kept: the roster check is recorded only at start and on change, so it may be older than the window.
    const traces = yield* Traces.query((yield* Home).root, {
      since: 0,
      limit: Number.POSITIVE_INFINITY,
    });
    return summarize({ traces, since: now - windowMs, now, agents, counted: countedOn(config) });
  });

const local = (at: string) => at.replace("T", " ").slice(0, 16);

const counts = (record: Readonly<Record<string, number | undefined>>) =>
  Object.entries(record)
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");

/** One line per agent with something to say, then the quiet ones on one line. */
export const render = (health: Health): string => {
  const lines = [
    `health ${local(health.since)} to ${local(health.now)} UTC (cron ticks counted from ${local(health.ticksSince)})`,
  ];
  const { roster } = health;
  lines.push(
    roster === undefined
      ? "roster: the service has recorded no roster check (not running this version yet?)"
      : `roster (service check ${local(roster.at)}): ${roster.loaded} agents loaded, ${roster.missing.length === 0 ? "none missing" : `MISSING ${roster.missing.map(({ id }) => id).join(", ")}`}`,
  );
  const quiet: Array<string> = [];
  for (const agent of health.agents) {
    const parts = [
      agent.missing === undefined ? "" : `MISSING from the service: ${agent.missing}`,
      agent.lastRun === undefined
        ? ""
        : `last ${local(agent.lastRun.at)} ${agent.lastRun.ok ? "ok" : "failed"}${agent.lastRun.trigger === undefined ? "" : ` (${agent.lastRun.trigger})`}`,
      agent.runs === 0 ? "" : `runs ${agent.runs}`,
      agent.failures === 0 ? "" : `failures ${agent.failures}`,
      agent.fallbacks === 0 ? "" : `fallbacks ${agent.fallbacks}`,
      ...agent.crons.map(
        (cron) =>
          `cron ${cron.job} "${cron.cron}": expected ${cron.expected}, ran ${cron.ran}, missed ${cron.missed}${Object.keys(cron.reasons).length === 0 ? "" : ` (${counts(cron.reasons)})`}${cron.unaccounted === 0 ? "" : `, unaccounted ${cron.unaccounted}`}`,
      ),
      Object.keys(agent.outcomes).length === 0 ? "" : `outcomes ${counts(agent.outcomes)}`,
    ].filter((part) => part !== "");
    const name = `${agent.agent}${agent.mode === undefined ? "" : ` [${agent.mode}]`}${agent.enabled === undefined ? " (not loaded here)" : agent.enabled ? "" : " (disabled)"}`;
    if (parts.length === 0) quiet.push(name);
    else lines.push(`${name}  ${parts.join("  ")}`);
  }
  if (quiet.length > 0) lines.push(`no runs in the window: ${quiet.join(", ")}`);
  return lines.join("\n");
};
