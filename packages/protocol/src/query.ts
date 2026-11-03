// Live widget data: the allowlisted, read-only host tools an OpenUI `Query(tool, args, defaults,
// refreshSec)` resolves to on dashboards and canvas `ui` nodes. Each tool has a zod schema for its
// args (strict: an unknown key is an error) and one for its result (the host parses what it returns
// through it, so only the listed fields ever leave the host). Nothing here writes, sends or reads a
// secret. Clients reach the host three ways, all answered by the same service: the `query.req`
// frame (paired devices; offered when `welcome.features` has "query"), loopback `POST /query`
// (Relay Desktop on this Mac, the CLI) and `POST /canvas/<slug>/query?token=` (the canvas web client).

import { z } from "zod";
import { MAX_REFRESH_SEC, MIN_REFRESH_SEC } from "./openui/queries";

/** Shortest refresh interval a Query may ask for, in seconds; shorter ones are rejected on write. */
export const QUERY_MIN_REFRESH_SEC = MIN_REFRESH_SEC;
/** Longest refresh interval, in seconds (an hour). */
export const QUERY_MAX_REFRESH_SEC = MAX_REFRESH_SEC;
/** `welcome.features` entry of a host that answers `query.req`. */
export const QUERY_FEATURE = "query";

const Limit = (fallback: number, max = 100) => z.number().int().min(1).max(max).default(fallback);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** Local wall-clock time of the read, "HH:MM:SS", for "as of" captions. */
const AsOf = z.string();
/** Epoch ms of the read. */
const At = z.number();

const WorkItem = z.object({
  key: z.string(),
  title: z.string(),
  workspace: z.string(),
  stage: z.string(),
  /** Whose move it is (isaac, steve, eva, ...). */
  move: z.string().optional(),
  next: z.string().optional(),
  linear: z.string().optional(),
  pr: z.string().optional(),
  updated: z.string().optional(),
});

const Job = z.object({
  name: z.string(),
  every: z.string().optional(),
  enabled: z.boolean(),
  kind: z.enum(["script", "session"]),
  /** Epoch ms of the last run start, absent when it never ran. */
  lastRunAt: z.number().optional(),
  /** "5m ago", "2h ago", "3d ago"; absent when it never ran. */
  lastRunAgo: z.string().optional(),
  /** The last run's verdict: "ok", "failed", "running", or absent when unknown. */
  lastResult: z.string().optional(),
  /** The last line of the job's log, clipped. */
  lastLine: z.string().optional(),
});

const LinearIssue = z.object({
  key: z.string(),
  title: z.string(),
  state: z.string(),
  stateType: z.string(),
  priority: z.string(),
  team: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  updatedAgo: z.string(),
});

const PullRequest = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  draft: z.boolean(),
  state: z.string(),
  updatedAt: z.string(),
  updatedAgo: z.string(),
});

const RelaySession = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z.string(),
  lastActivity: z.string(),
  lastActivityAgo: z.string(),
  model: z.string().optional(),
});

const RelayAssistant = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  lastReply: z.string().optional(),
});

const Count = z.object({ name: z.string(), count: z.number() });

/** Every query tool: what it reads, its args and its result. */
export const QUERY_TOOLS = {
  work_items: {
    description:
      "Open work items (the ledgers in work/items): key, title, workspace, stage, whose move, next step; plus counts per workspace. Optional workspace slug and move filters.",
    args: z
      .object({
        workspace: Slug.optional(),
        move: z.string().min(1).max(40).optional(),
        limit: Limit(50),
      })
      .strict(),
    result: z.object({
      asOf: AsOf,
      at: At,
      total: z.number(),
      byWorkspace: z.array(Count),
      items: z.array(WorkItem),
    }),
    /** Results younger than this are served from the cache. */
    ttlMs: 10_000,
  },
  jobs: {
    description:
      "Eva's background jobs (jobs/*/job.md) with their schedule and last run: when, how long ago, the verdict and the last log line. Optional job name.",
    args: z.object({ name: Slug.optional() }).strict(),
    result: z.object({
      asOf: AsOf,
      at: At,
      total: z.number(),
      failing: z.number(),
      jobs: z.array(Job),
    }),
    ttlMs: 10_000,
  },
  linear_issues: {
    description:
      'Isaac\'s assigned Linear issues: key, title, state, priority, team, url. state: "active" (default: started + unstarted), "started", "unstarted", "backlog" or "triage"; optional team key.',
    args: z
      .object({
        state: z.enum(["active", "started", "unstarted", "backlog", "triage"]).default("active"),
        team: z
          .string()
          .regex(/^[A-Z][A-Z0-9]{0,9}$/)
          .optional(),
        limit: Limit(25, 50),
      })
      .strict(),
    result: z.object({
      asOf: AsOf,
      at: At,
      total: z.number(),
      byState: z.array(Count),
      issues: z.array(LinearIssue),
    }),
    ttlMs: 60_000,
  },
  github_prs: {
    description:
      'GitHub pull requests through gh: filter "authored" (default), "review-requested", "assigned" or "mentioned" (all relative to Isaac); state "open" (default), "closed" or "merged"; optional owner or repo ("owner/name").',
    args: z
      .object({
        filter: z.enum(["authored", "review-requested", "assigned", "mentioned"]).default("authored"),
        state: z.enum(["open", "closed", "merged"]).default("open"),
        owner: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)
          .optional(),
        repo: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/)
          .optional(),
        limit: Limit(20, 50),
      })
      .strict(),
    result: z.object({
      asOf: AsOf,
      at: At,
      total: z.number(),
      prs: z.array(PullRequest),
    }),
    ttlMs: 60_000,
  },
  relay_sessions: {
    description:
      'Relay\'s omp sessions (title, status, kind, last activity) with counts by status, and the assistant threads with their status. kind: "all" (default), "manual", "job" or "assistant"; ended sessions are left out.',
    args: z
      .object({
        kind: z.enum(["all", "manual", "job", "assistant"]).default("all"),
        limit: Limit(30),
      })
      .strict(),
    result: z.object({
      asOf: AsOf,
      at: At,
      total: z.number(),
      byStatus: z.array(Count),
      sessions: z.array(RelaySession),
      assistants: z.array(RelayAssistant),
    }),
    ttlMs: 5_000,
  },
} as const;

export type QueryToolName = keyof typeof QUERY_TOOLS;
export type QueryArgs<T extends QueryToolName> = z.infer<(typeof QUERY_TOOLS)[T]["args"]>;
export type QueryResult<T extends QueryToolName> = z.infer<(typeof QUERY_TOOLS)[T]["result"]>;

export const QUERY_TOOL_NAMES = Object.keys(QUERY_TOOLS) as QueryToolName[];

export function isQueryTool(name: string): name is QueryToolName {
  return Object.hasOwn(QUERY_TOOLS, name);
}

/** Body of `POST /query` and `POST /canvas/<slug>/query`. */
export const QueryRequest = z.object({
  tool: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional(),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

/** The answer to one query, on every route. */
export type QueryAnswer = { ok: true; data: unknown } | { ok: false; error: string };

/** A tool's args checked against its schema: the parsed args, or why they are refused. */
export function checkQueryArgs(tool: string, args: unknown): { ok: true; tool: QueryToolName; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!isQueryTool(tool)) return { ok: false, error: `unknown query tool "${tool}" (tools: ${QUERY_TOOL_NAMES.join(", ")})` };
  const parsed = QUERY_TOOLS[tool].args.safeParse(args ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues.map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`)).join("; ");
    return { ok: false, error: `${tool} args: ${why}` };
  }
  return { ok: true, tool, args: parsed.data };
}

/** The tools as the OpenUI prompt and the skills list them. */
export function queryToolsPrompt(): string {
  return QUERY_TOOL_NAMES.map((name) => `- ${name}: ${QUERY_TOOLS[name].description}`).join("\n");
}
