// Fake Linear (a `fetch` that answers the tickets sync's GraphQL from synthetic fixtures) and fake
// gh (a ToolRun for `gh api graphql --include` and `gh api user`), plus a TicketsService harness on
// a simulated clock. Nothing here reaches a network or a real gh.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi, type Mock } from "vitest";
import { SimulatedClock } from "xstate";
import type { ToolRun } from "../src/reviews/exec";
import { ghCall, ghGraphql } from "../src/reviews/github";
import { linearGql } from "../src/reviews/linear";
import { providerBudgets } from "../src/tickets/budget";
import { TicketsService, type TicketsGate, type TicketsPush } from "../src/tickets/service";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/tickets/${name}`, import.meta.url), "utf8"));

type Json = Record<string, unknown>;
export const T0 = Date.parse("2026-11-27T12:00:00.000Z");

/** A Linear issue node from the fixture with this key, updated at `updatedAt`, linking `prs` (`o/r#n`). */
export function issueNode(key: string, updatedAt: number, prs: readonly string[] = []): Json {
  const node = structuredClone(fixture("issue-node.json")) as Json;
  const attachments = prs.map((p) => {
    const [repo, n] = p.split("#");
    return { url: `https://github.com/${repo ?? ""}/pull/${n ?? ""}` };
  });
  return { ...node, id: `id-${key}`, identifier: key, url: `https://linear.app/acme/issue/${key}`, updatedAt: new Date(updatedAt).toISOString(), attachments: { nodes: attachments } };
}

type Kind = "viewer" | "notices" | "teams" | "detail" | "ids" | "issues" | "keys";

function kindOf(query: string, variables: Json): Kind {
  if (query.includes("notifications(")) return "notices";
  if (query.includes("teams(")) return "teams";
  if (query.includes("issue(id:")) return "detail";
  if (query.includes("nodes { identifier }")) return "ids";
  if (query.includes("issues(")) return JSON.stringify(variables["filter"] ?? {}).includes('"team"') ? "keys" : "issues";
  return "viewer";
}

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Linear as the sync sees it: members (on the board's filter), other readable issues, notifications. */
export class FakeLinear {
  viewer = (fixture("viewer.json") as { viewer: Json }).viewer;
  readonly members = new Map<string, Json>();
  /** Readable by key but not members (an agent card's ticket). */
  readonly others = new Map<string, Json>();
  notices: Json[] = [];
  readonly calls: Kind[] = [];
  /** Answers given instead of the next calls (a 429, an error). */
  readonly queued: Response[] = [];
  /** While set, issue pages wait for it (a cycle caught mid-flight). */
  blocked: Promise<void> | null = null;
  /** The gate's named queries and mutations (`TicketIssueSubscribers`, ...), answered by name. */
  readonly gateOps = new Map<string, (v: Json) => unknown>();
  /** Every gate call with the key it was sent with. */
  readonly gateCalls: { op: string; key: string }[] = [];
  /** Kinds Linear answers 500 to while listed. */
  readonly failing = new Set<Kind>();

  add(key: string, updatedAt: number, prs: readonly string[] = []): void {
    this.members.set(key, issueNode(key, updatedAt, prs));
  }

  count(kind: Kind): number {
    return this.calls.filter((k) => k === kind).length;
  }

  readonly fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const { query, variables = {} } = JSON.parse(String(init?.body)) as { query: string; variables?: Json };
    const named = /^(?:query|mutation) (Ticket\w+)/.exec(query)?.[1];
    if (named !== undefined) {
      this.gateCalls.push({ op: named, key: new Headers(init?.headers).get("authorization") ?? "" });
      const handler = this.gateOps.get(named);
      return handler === undefined ? answer({ errors: [{ message: `unexpected ${named}` }] }, 400) : answer({ data: handler(variables) });
    }
    const kind = kindOf(query, variables);
    this.calls.push(kind);
    if (kind === "issues" && this.blocked !== null) await this.blocked;
    if (this.failing.has(kind)) return answer({ errors: [{ message: "Internal server error" }] }, 500);
    const queued = this.queued.shift();
    return queued ?? answer({ data: this.data(kind, variables) });
  };

  private data(kind: Kind, v: Json): unknown {
    const all = new Map([...this.others, ...this.members]);
    const table: Record<Kind, () => unknown> = {
      viewer: () => ({ viewer: this.viewer }),
      notices: () => ({ notifications: { nodes: this.notices } }),
      teams: () => fixture("teams.json"),
      detail: () => ({ issue: all.get(String(v["id"])) ?? null }),
      ids: () => this.page(this.keyed(this.members, v), v, (n) => ({ identifier: n["identifier"] })),
      keys: () => this.page(this.keyed(all, v), v, (n) => n),
      issues: () => this.page(this.changed(v), v, (n) => n),
    };
    return table[kind]();
  }

  /** Members changed after the filter's `updatedAt.gt`, newest first. */
  private changed(v: Json): Json[] {
    const since = /"updatedAt":\{"gt":"([^"]+)"\}/.exec(JSON.stringify(v["filter"]))?.[1];
    const after = since === undefined ? 0 : Date.parse(since);
    return [...this.members.values()].filter((n) => Date.parse(String(n["updatedAt"])) > after).sort((a, b) => Date.parse(String(b["updatedAt"])) - Date.parse(String(a["updatedAt"])));
  }

  /** The issues of `pool` a by-key filter names (alone or inside an `and`); no keys: the whole pool. */
  private keyed(pool: Map<string, Json>, v: Json): Json[] {
    type KeyClause = { team?: { key: { eq: string } }; number?: { eq: number } };
    const filter = v["filter"] as { or?: KeyClause[]; and?: { or?: KeyClause[] }[] };
    const clauses = [filter.or, ...(filter.and ?? []).map((f) => f.or)].find((or) => or?.[0]?.team !== undefined);
    if (clauses === undefined) return [...pool.values()];
    return clauses.flatMap((f) => {
      const node = pool.get(`${f.team?.key.eq ?? ""}-${String(f.number?.eq)}`);
      return node === undefined ? [] : [node];
    });
  }

  private page(nodes: Json[], v: Json, shape: (n: Json) => unknown): unknown {
    const start = v["after"] === null || v["after"] === undefined ? 0 : Number(v["after"]);
    const first = Number(v["first"]);
    const slice = nodes.slice(start, start + first);
    const next = start + first < nodes.length;
    return { issues: { nodes: slice.map(shape), pageInfo: { hasNextPage: next, endCursor: next ? String(start + first) : null } } };
  }
}

/** A PR's full facts node from the fixture. */
export function prNode(ref: string, over: Json = {}): Json {
  const [repo = "", n = "1"] = ref.split("#");
  const node = structuredClone(fixture("pr-facts.json")) as Json;
  return { ...node, number: Number(n), url: `https://github.com/${repo}/pull/${n}`, ...over };
}

/** What the probe asks of a PR, derived from its facts node. */
function probeOf(f: Json): Json {
  const commits = f["commits"] as { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  const comments = f["comments"] as { nodes: Json[] };
  return {
    updatedAt: f["updatedAt"],
    headRefOid: f["headRefOid"],
    reviewDecision: f["reviewDecision"],
    mergeStateStatus: f["mergeStateStatus"],
    isDraft: f["isDraft"],
    state: f["state"],
    commits: { nodes: commits.nodes.map((c) => ({ commit: { statusCheckRollup: c.commit.statusCheckRollup === null ? null : { state: c.commit.statusCheckRollup.state } } })) },
    comments: { nodes: comments.nodes.map((c) => ({ id: c["id"], updatedAt: c["createdAt"], reactionGroups: c["reactionGroups"] })) },
    reviewThreads: { nodes: [] },
  };
}

const ALIAS = /p(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g;

/** The batch's aliases (`p0`) and the PR each asks for. */
function aliasesOf(query: string): { alias: string; repo: string; ref: string }[] {
  return [...query.matchAll(ALIAS)].map((m) => {
    const repo = `${m[2] ?? ""}/${m[3] ?? ""}`;
    return { alias: `p${m[1] ?? ""}`, repo, ref: `${repo}#${m[4] ?? ""}` };
  });
}

/** gh: `auth token`, `api user` and `api graphql --include` over `prs` (null: no access). */
export class FakeGh {
  login: string | null = "pat-example";
  /** What `gh auth token` prints; null: signed out. */
  token: string | null = "gho_test";
  readonly prs = new Map<string, Json | null>();
  readonly calls: { kind: "user" | "probe" | "facts"; refs: string[] }[] = [];
  /** Every call's argv with the GH_TOKEN it ran with (null: gh's own sign-in). */
  readonly envs: { argv: readonly string[]; token: string | null }[] = [];

  readonly run: ToolRun = (argv, options) => {
    this.envs.push({ argv, token: options.env?.["GH_TOKEN"] ?? null });
    if (argv.includes("auth")) return Promise.resolve({ code: this.token === null ? 1 : 0, stdout: this.token ?? "", stderr: "", timedOut: false });
    return Promise.resolve({ ...(argv.includes("user") ? this.user() : this.graphql(argv)), timedOut: false });
  };

  private user(): { code: number; stdout: string; stderr: string } {
    this.calls.push({ kind: "user", refs: [] });
    if (this.login === null) return { code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" };
    return { code: 0, stdout: `${this.login}\n`, stderr: "" };
  }

  private graphql(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
    const query = argv.find((a) => a.startsWith("query="))?.slice(6) ?? "";
    const facts = query.includes("viewerDidAuthor");
    const data: Json = {};
    const errors: Json[] = [];
    const refs: string[] = [];
    for (const { alias, repo, ref } of aliasesOf(query)) {
      refs.push(ref);
      const node = this.prs.get(ref) ?? null;
      data[alias] = node === null ? null : { pullRequest: facts ? node : probeOf(node) };
      if (node === null) errors.push({ message: `Could not resolve to a Repository with the name '${repo}'.` });
    }
    this.calls.push({ kind: facts ? "facts" : "probe", refs });
    const head = "HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 4990\r\nX-Ratelimit-Reset: 1800000000\r\n\r\n";
    return { code: errors.length > 0 ? 1 : 0, stdout: head + JSON.stringify({ data, errors }), stderr: "" };
  }

  count(kind: "user" | "probe" | "facts"): number {
    return this.calls.filter((c) => c.kind === kind).length;
  }
}

export interface TicketsHarness {
  readonly service: TicketsService;
  readonly linear: FakeLinear;
  readonly gh: FakeGh;
  readonly gate: Record<keyof TicketsGate, Mock>;
  /** The host's Linear key file; set `value` to rotate it. */
  readonly key: { value: string | null };
  readonly pushes: TicketsPush[];
  readonly dir: string;
  now(): number;
  /** Moves the host clock and the machine's clock together. */
  advance(ms: number): void;
  /** Waits until the running cycle ended (waiting, backing off or off). */
  settled(): Promise<void>;
  /** tickets.json as written. */
  file(): StoreFileView;
}

export interface StoreFileView {
  readonly rev: number;
  readonly issues: Record<string, unknown>;
  readonly sync: { readonly watermark: number | null; readonly cursor: unknown; readonly noticesAt: number | null };
}

/** `realGate`: the service's own MutationGate over `linear`'s gate ops instead of the `gate` mocks. */
export function ticketsHarness(o: { writes?: boolean; dir?: string; linear?: FakeLinear; gh?: FakeGh; realGate?: boolean; ghWrites?: boolean; summaryWriter?: (prompt: string) => Promise<string> } = {}): TicketsHarness {
  let now = T0;
  const clock = new SimulatedClock();
  const budgets = providerBudgets(() => now);
  const linear = o.linear ?? new FakeLinear();
  const gh = o.gh ?? new FakeGh();
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "relay-tickets-"));
  const key: { value: string | null } = { value: "lin_api_test" };
  const gate = {
    prepare: vi.fn(() => Promise.resolve({ ok: true, approval: { id: "approval-1", expiresAt: now + 120_000, summary: "ok" } })),
    commit: vi.fn(() => Promise.resolve({ ok: true, outcome: { opId: "00000000-0000-4000-8000-000000000000", state: "done" as const } })),
    invalidate: vi.fn(),
  };
  const pushes: TicketsPush[] = [];
  const service = new TicketsService({
    dir,
    gql: linearGql(() => key.value, linear.fetch, budgets.linear.background),
    linearKey: () => key.value,
    keyedGql: (k) => linearGql(() => k, linear.fetch, budgets.linear),
    ghGraphql: ghGraphql(gh.run, "gh", budgets.github.background),
    ghLogin: async () => (await ghCall(gh.run, "gh", budgets.github.background, ["api", "user", "--jq", ".login"]).catch(() => "")).trim() || null,
    budgets,
    writes: o.writes ?? false,
    now: () => now,
    log: () => undefined,
    sync: { clock, timing: { random: () => 0.5 } },
    ...(o.realGate === true ? {} : { gate }),
    ...(o.summaryWriter && { summaryWriter: o.summaryWriter }),
    ...(o.ghWrites === true && { ghWrites: { run: gh.run, gh: "gh" } }),
  });
  service.onPush = (m) => pushes.push(m);
  return {
    service,
    linear,
    gh,
    gate,
    key,
    pushes,
    dir,
    now: () => now,
    advance: (ms) => {
      now += ms;
      clock.increment(ms);
    },
    settled: () =>
      vi.waitFor(
        () => {
          expect(["waiting", "backingOff", "off"]).toContain(service.status().freshness.state);
        },
        { interval: 1 },
      ),
    file: () => JSON.parse(readFileSync(join(dir, "tickets.json"), "utf8")) as StoreFileView,
  };
}
