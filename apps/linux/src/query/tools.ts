// The read-only sources behind `QUERY_TOOLS` (packages/protocol/src/query.ts): Eva's work ledgers
// and job shelf on disk, Isaac's Linear issues (GraphQL with his key, read-only query), GitHub PRs
// (`gh search prs`, fixed flags, args validated before they reach argv), Relay's own sessions and
// assistant threads, and GoodOps' collections aggregates (goodops.ts). Each returns plain JSON that
// the service parses through the tool's result schema, so a field not listed there never leaves the host.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AssistantAgent, QueryArgs, QueryToolName } from "@relay/protocol";
import { z } from "zod";
import type { ToolRun } from "../reviews/exec";
import { goodopsCollections, type GoodOpsSource } from "./goodops";

export type QueryTools = { readonly [K in QueryToolName]: (args: QueryArgs<K>) => Promise<unknown> };

export interface QueryToolDeps {
  /** Eva's root (work/items, jobs, workspaces); null: the file tools fail with a reason. */
  readonly evaRoot: string | null;
  readonly run: ToolRun;
  readonly gh: string;
  readonly linearKey: () => string | null;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly sessions: () => readonly AgentSession[];
  readonly assistants: () => Promise<readonly AssistantAgent[]>;
  readonly now: () => number;
  /** GoodOps' read-only database and FieldRoutes access; null when secrets/goodops-readonly.env is missing. */
  readonly goodops: () => GoodOpsSource | null;
}

const GH_TIMEOUT_MS = 20_000;
const LINEAR_TIMEOUT_MS = 15_000;
const MAX_LINE = 240;

/** "HH:MM:SS" in the host's local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** "now", "5m ago", "3h ago", "2d ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${String(Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))}h ago`;
  return `${String(Math.floor(s / 86_400))}d ago`;
}

const clip = (text: string): string => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text);

/** The `key: value` lines of a leading `---` block. */
export function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    const value = (m?.[2] ?? "").trim();
    // An empty value is no value: `worktree:` with nothing after it is absent.
    if (m?.[1] !== undefined && value !== "") out[m[1]] = value;
  }
  return out;
}

function root(deps: QueryToolDeps): string {
  if (deps.evaRoot === null) throw new Error("this host has no Eva root (--agent-home)");
  return deps.evaRoot;
}

function counts(names: readonly string[]): { name: string; count: number }[] {
  const by = new Map<string, number>();
  for (const name of names) by.set(name, (by.get(name) ?? 0) + 1);
  return [...by].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** `workspaces/<slug>.md`'s first heading ("eCard Systems"), else the slug. */
function workspaceName(evaRoot: string, slug: string, cache: Map<string, string>): string {
  const known = cache.get(slug);
  if (known !== undefined) return known;
  let name = slug;
  try {
    const heading = /^#\s+(.+)$/m.exec(readFileSync(join(evaRoot, "workspaces", `${slug}.md`), "utf8"))?.[1]?.trim();
    if (heading !== undefined && heading !== "") name = heading;
  } catch {
    // No workspace file: the slug names it.
  }
  cache.set(slug, name);
  return name;
}

function workItems(deps: QueryToolDeps, args: QueryArgs<"work_items">): unknown {
  const evaRoot = root(deps);
  const dir = join(evaRoot, "work", "items");
  const names = new Map<string, string>();
  const all = [];
  for (const file of readdirSync(dir)) {
    // Ledgers are <KEY>.md; <KEY>.pr-body.md, <KEY>.plan.md and friends are not.
    if (!/^[A-Za-z0-9-]+\.md$/.test(file) || file.startsWith("_")) continue;
    const fm = frontmatter(readFileSync(join(dir, file), "utf8"));
    const key = fm["key"];
    if (key === undefined || key === "") continue;
    const slug = fm["workspace"] ?? "";
    all.push({
      key,
      title: fm["title"] ?? key,
      workspace: workspaceName(evaRoot, slug, names),
      slug,
      stage: fm["stage"] ?? "",
      move: fm["move"],
      next: fm["next"] ? clip(fm["next"]) : undefined,
      linear: fm["linear"],
      pr: fm["pr"],
      updated: fm["updated"],
    });
  }
  const matching = all.filter((item) => (args.workspace === undefined || item.slug === args.workspace) && (args.move === undefined || item.move === args.move));
  matching.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.key.localeCompare(b.key));
  const now = deps.now();
  return {
    asOf: clockTime(now),
    at: now,
    total: matching.length,
    byWorkspace: counts(matching.map((item) => item.workspace)),
    items: matching.slice(0, args.limit),
  };
}

/** The last line of `file` that matches `pattern`, reading only its last 64 KB. */
function lastMatch(file: string, pattern: RegExp): string | null {
  let text: string;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, 64_000);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) if (pattern.test(lines[i] ?? "")) return lines[i] ?? null;
  return null;
}

const RunStatus = z.object({ state: z.string(), check: z.string().optional(), note: z.string().optional() });

/** The newest run dir's status.json of a session job. */
function sessionRunStatus(runs: string): z.infer<typeof RunStatus> | null {
  let dirs: string[];
  try {
    dirs = readdirSync(runs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
  for (let i = dirs.length - 1; i >= 0; i--) {
    const file = join(runs, dirs[i] ?? "", "status.json");
    if (!existsSync(file)) continue;
    try {
      return RunStatus.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }
  return null;
}

function jobs(deps: QueryToolDeps, args: QueryArgs<"jobs">): unknown {
  const evaRoot = root(deps);
  const shelf = join(evaRoot, "jobs");
  const now = deps.now();
  const out = [];
  for (const entry of readdirSync(shelf, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (args.name !== undefined && entry.name !== args.name) continue;
    const spec = join(shelf, entry.name, "job.md");
    if (!existsSync(spec)) continue;
    const fm = frontmatter(readFileSync(spec, "utf8"));
    const runs = join(shelf, ".runs", entry.name);
    const kind = fm["script"] ? ("script" as const) : ("session" as const);
    let lastRunAt: number | undefined;
    try {
      const ms = Number(readFileSync(join(runs, "last-run"), "utf8").trim());
      if (Number.isFinite(ms) && ms > 0) lastRunAt = ms;
    } catch {
      // Never ran.
    }
    const verdict = lastMatch(join(runs, "job.log"), /^\[[^\]]+\] (script (ok|failed)|END \w+)/);
    let lastResult: string | undefined;
    if (kind === "session") {
      const status = sessionRunStatus(runs);
      if (status) lastResult = status.state === "done" ? (status.check === "fail" ? "failed" : "ok") : status.state === "running" ? "running" : "failed";
    } else if (verdict !== null) {
      lastResult = verdict.includes("] script ok") ? "ok" : "failed";
    }
    const lastLine = lastMatch(join(runs, "job.log"), /\S/);
    out.push({
      name: entry.name,
      every: fm["every"],
      enabled: fm["enabled"] !== "false",
      kind,
      lastRunAt,
      lastRunAgo: lastRunAt === undefined ? undefined : ago(lastRunAt, now),
      lastResult,
      lastLine: lastLine === null ? undefined : clip(lastLine.replace(/^\[[^\]]+\]\s*/, "")),
    });
  }
  out.sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.name.localeCompare(b.name));
  return { asOf: clockTime(now), at: now, total: out.length, failing: out.filter((j) => j.lastResult === "failed").length, jobs: out };
}

const LinearData = z.object({
  data: z.object({
    viewer: z.object({
      assignedIssues: z.object({
        nodes: z.array(
          z.object({
            identifier: z.string(),
            title: z.string(),
            url: z.string(),
            priorityLabel: z.string(),
            updatedAt: z.string(),
            state: z.object({ name: z.string(), type: z.string() }),
            team: z.object({ key: z.string() }),
          }),
        ),
      }),
    }),
  }),
});

const LINEAR_STATES: Record<QueryArgs<"linear_issues">["state"], string[]> = {
  active: ["started", "unstarted"],
  started: ["started"],
  unstarted: ["unstarted"],
  backlog: ["backlog"],
  triage: ["triage"],
};

async function linearIssues(deps: QueryToolDeps, args: QueryArgs<"linear_issues">): Promise<unknown> {
  const key = deps.linearKey();
  if (key === null) throw new Error("no Linear key (LINEAR_API_KEY or secrets/linear.env)");
  const filter: Record<string, unknown> = { state: { type: { in: LINEAR_STATES[args.state] } } };
  if (args.team !== undefined) filter["team"] = { key: { eq: args.team } };
  const query = `query($filter: IssueFilter, $first: Int) { viewer { assignedIssues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { identifier title url priorityLabel updatedAt state { name type } team { key } } } } }`;
  const res = await deps.fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables: { filter, first: args.limit } }),
    signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Linear answered ${String(res.status)}`);
  const parsed = LinearData.safeParse(await res.json());
  if (!parsed.success) throw new Error("Linear answered something unexpected");
  const now = deps.now();
  const issues = parsed.data.data.viewer.assignedIssues.nodes.map((n) => ({
    key: n.identifier,
    title: n.title,
    state: n.state.name,
    stateType: n.state.type,
    priority: n.priorityLabel,
    team: n.team.key,
    url: n.url,
    updatedAt: n.updatedAt,
    updatedAgo: ago(Date.parse(n.updatedAt), now),
  }));
  return { asOf: clockTime(now), at: now, total: issues.length, byState: counts(issues.map((i) => i.state)), issues };
}

const GhPrs = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    url: z.string(),
    isDraft: z.boolean().optional(),
    state: z.string(),
    updatedAt: z.string(),
    author: z.object({ login: z.string() }).nullable().optional(),
    repository: z.object({ nameWithOwner: z.string() }),
  }),
);

const GH_FILTER: Record<QueryArgs<"github_prs">["filter"], string> = {
  authored: "--author=@me",
  "review-requested": "--review-requested=@me",
  assigned: "--assignee=@me",
  mentioned: "--mentions=@me",
};

async function githubPrs(deps: QueryToolDeps, args: QueryArgs<"github_prs">): Promise<unknown> {
  const argv = [deps.gh, "search", "prs", GH_FILTER[args.filter], `--limit=${String(args.limit)}`, "--sort=updated", "--json=number,title,url,isDraft,state,updatedAt,author,repository"];
  argv.push(args.state === "merged" ? "--merged" : `--state=${args.state}`);
  if (args.repo !== undefined) argv.push(`--repo=${args.repo}`);
  else if (args.owner !== undefined) argv.push(`--owner=${args.owner}`);
  const result = await deps.run(argv, { cwd: deps.evaRoot ?? "/", timeoutMs: GH_TIMEOUT_MS });
  if (result.timedOut) throw new Error("gh timed out");
  if (result.code !== 0) throw new Error(`gh failed: ${clip(result.stderr.trim().split("\n")[0] ?? "")}`);
  const parsed = GhPrs.safeParse(JSON.parse(result.stdout));
  if (!parsed.success) throw new Error("gh answered something unexpected");
  const now = deps.now();
  const prs = parsed.data.map((pr) => ({
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? "",
    draft: pr.isDraft === true,
    state: pr.state.toLowerCase(),
    updatedAt: pr.updatedAt,
    updatedAgo: ago(Date.parse(pr.updatedAt), now),
  }));
  return { asOf: clockTime(now), at: now, total: prs.length, prs };
}

async function relaySessions(deps: QueryToolDeps, args: QueryArgs<"relay_sessions">): Promise<unknown> {
  const now = deps.now();
  const live = deps.sessions().filter((s) => s.status !== "ended" && (args.kind === "all" || (s.kind ?? "manual") === args.kind));
  const assistants = await deps.assistants();
  return {
    asOf: clockTime(now),
    at: now,
    total: live.length,
    byStatus: counts(live.map((s) => s.status)),
    sessions: live.slice(0, args.limit).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      kind: s.kind ?? "manual",
      lastActivity: clip(s.lastActivity),
      lastActivityAgo: ago(s.lastActivityAt, now),
      model: s.model,
    })),
    assistants: assistants.map((a) => ({ id: a.id, title: a.title, status: a.status ?? "not_started", lastReply: a.lastReply === undefined ? undefined : clip(a.lastReply.text) })),
  };
}

export function queryTools(deps: QueryToolDeps): QueryTools {
  return {
    work_items: (args) => Promise.resolve().then(() => workItems(deps, args)),
    jobs: (args) => Promise.resolve().then(() => jobs(deps, args)),
    linear_issues: (args) => linearIssues(deps, args),
    github_prs: (args) => githubPrs(deps, args),
    relay_sessions: (args) => relaySessions(deps, args),
    goodops_collections: goodopsCollections(deps),
  };
}
