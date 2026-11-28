// GitHub in Reviews: Isaac's review queue in the eCardSystems org and one PR's detail, read with
// `gh` (evaos-electron reviews-ipc.ts). Writes leave only on an explicit, confirmed action: a PR
// comment or a review.

import { homedir } from "node:os";
import { MAX_REVIEW_DIFF, PR_VIEW_FIELDS, type PrMergeMethod, type ReviewActionCheck, type ReviewItem, type ReviewPr, type ReviewPrActions } from "@relay/protocol";
import { z } from "zod";
import type { ProviderBudget } from "../tickets/budget";
import type { ToolRun } from "./exec";
import type { Fetch, ReviewMedia } from "./linear";
import { isGithubUpload, isLinearUpload, localizeImages } from "./media";

export const REVIEWS_ORG = "eCardSystems";
/** Failed Actions runs whose attempt one PR read asks for. */
const MAX_ATTEMPT_READS = 20;
const GH_TIMEOUT_MS = 60_000;

const ms = (iso: unknown): number => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

export interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  user: { login: string } | null;
  updated_at: string;
  draft?: boolean;
}

/** A search row as a queue row: `needs` (his review is requested), `reviewing` (he reviewed, it moved), or one of Relay Desktop's `completed`/`created` lists (no group). */
export function toItem(item: SearchItem, group: "needs" | "reviewing" | "completed" | "created"): ReviewItem {
  const reason = { needs: "requested your review", reviewing: "updated since your review", completed: "you reviewed", created: "you opened" }[group];
  return {
    url: item.html_url,
    ref: { kind: "github", repo: item.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, ""), number: item.number },
    title: item.title,
    actor: item.user?.login ?? "ghost",
    reason,
    label: `#${String(item.number)}`,
    updatedAt: ms(item.updated_at),
    unread: true,
    draft: item.draft === true,
    ...(group === "needs" || group === "reviewing" ? { group } : {}),
  };
}

export interface RawPr {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  commits: {
    oid: string;
    messageHeadline: string;
    authoredDate: string;
    authors: { login?: string; name?: string }[];
  }[];
  files: { path: string; additions: number; deletions: number; changeType?: string }[];
  reviewRequests: { login?: string; name?: string; slug?: string }[];
  latestReviews: { author: { login: string } | null; state: string }[];
  reviews: {
    author: { login: string } | null;
    state: string;
    body: string;
    submittedAt: string;
  }[];
  comments: { author: { login: string } | null; body: string; createdAt: string }[];
  assignees: { login: string }[];
  labels: { name: string; color: string }[];
  milestone?: { title: string } | null;
  projectItems?: { title?: string }[];
  statusCheckRollup: {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string | null;
    conclusion?: string | null;
    state?: string | null;
    detailsUrl?: string | null;
    targetUrl?: string | null;
  }[];
}

export const PR_JSON_FIELDS =
  "number,title,url,state,isDraft,author,createdAt,updatedAt,body,baseRefName,headRefName,headRefOid,additions,deletions,commits,files,reviewRequests,latestReviews,reviews,comments,assignees,labels,milestone,projectItems,statusCheckRollup";

const PASSED = ["SUCCESS", "NEUTRAL"];
const FAILED = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

function checkState(c: { conclusion?: string | null | undefined; state?: string | null | undefined }): ReviewPr["checks"][number]["state"] {
  const v = ([c.conclusion, c.state].find((s) => s !== null && s !== undefined && s !== "") ?? "").toUpperCase();
  if (v === "SKIPPED") return "skipped";
  if (PASSED.includes(v)) return "pass";
  if (FAILED.includes(v)) return "fail";
  return "pending";
}

const CHECK_ORDER = ["fail", "pending", "pass", "skipped"];

/** `gh pr view --json PR_JSON_FIELDS` plus `gh pr diff` as the protocol's PR; pushed commits join the timeline. */
export function toPr(repo: string, raw: RawPr, diff: string): ReviewPr {
  const login = (a: { login: string } | null): string => a?.login ?? "ghost";
  const requested = raw.reviewRequests.map((r) => r.login ?? r.slug ?? r.name ?? "?");
  const reviewed = raw.latestReviews.filter((r) => !requested.includes(login(r.author))).map((r) => ({ login: login(r.author), state: r.state }));
  const timeline: ReviewPr["timeline"] = [
    ...raw.comments.map((c) => ({ kind: "comment" as const, author: login(c.author), body: c.body, state: null, at: ms(c.createdAt) })),
    ...raw.reviews
      .filter((r) => r.body.trim() !== "" || r.state !== "COMMENTED")
      .map((r) => ({ kind: "review" as const, author: login(r.author), body: r.body, state: r.state, at: ms(r.submittedAt) })),
    ...raw.commits.map((c) => ({
      kind: "commit" as const,
      author: [c.authors[0]?.login, c.authors[0]?.name].find((s) => s !== undefined && s !== "") ?? "",
      body: c.messageHeadline,
      state: c.oid.slice(0, 7),
      at: ms(c.authoredDate),
    })),
  ].sort((a, b) => a.at - b.at);
  return {
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    draft: raw.isDraft,
    author: { login: login(raw.author) },
    createdAt: ms(raw.createdAt),
    updatedAt: ms(raw.updatedAt),
    body: raw.body,
    base: raw.baseRefName,
    head: raw.headRefName,
    headSha: raw.headRefOid,
    additions: raw.additions,
    deletions: raw.deletions,
    reviewers: [...requested.map((l) => ({ login: l, state: "PENDING" })), ...reviewed],
    assignees: raw.assignees.map((a) => a.login),
    labels: raw.labels.map((l) => ({ name: l.name, color: l.color })),
    milestone: raw.milestone?.title ?? null,
    projects: (raw.projectItems ?? []).map((p) => p.title ?? "").filter((t) => t !== ""),
    timeline,
    checks: raw.statusCheckRollup
      .map((c) => ({ name: c.name ?? c.context ?? "check", state: checkState(c), url: c.detailsUrl ?? c.targetUrl ?? null }))
      .sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state)),
    files: raw.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, change: f.changeType ?? "MODIFIED" })),
    diff: diff.length > MAX_REVIEW_DIFF ? diff.slice(0, MAX_REVIEW_DIFF) : diff,
    diffTruncated: diff.length > MAX_REVIEW_DIFF,
  };
}

/** What the Guide is written from. */
const GuidePr = z.object({
  title: z.string(),
  body: z.string(),
  headRefOid: z.string(),
  files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
});
export type GuidePr = z.infer<typeof GuidePr> & { diff: string };

/** gh's text for a spent primary or secondary limit. */
const GH_LIMIT = /rate limit|secondary rate|abuse detection/i;

/**
 * `gh <args>` through the GitHub budget when given: a spent budget throws `RateLimited` before gh
 * runs, and gh's rate-limit failure backs the budget off.
 */
export async function ghCall(run: ToolRun, gh: string, budget: ProviderBudget | null, args: readonly string[]): Promise<string> {
  budget?.take();
  const res = await run([gh, ...args], { cwd: homedir(), timeoutMs: GH_TIMEOUT_MS });
  if (res.timedOut) throw new Error(`gh ${args.slice(0, 2).join(" ")} took too long`);
  if (res.code !== 0) {
    const why = res.stderr.trim().split("\n")[0] ?? "";
    if (budget !== null && GH_LIMIT.test(res.stderr)) budget.limited();
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed${why === "" ? "" : `: ${why.slice(0, 200)}`}`);
  }
  return res.stdout;
}

/** `gh api --include` output: status line, headers, blank line, body. */
export function splitIncluded(out: string): { status: number; headers: Map<string, string>; body: string } {
  const cut = /\r?\n\r?\n/.exec(out);
  const head = cut === null ? "" : out.slice(0, cut.index);
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? "0");
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers, body: cut === null ? out : out.slice(cut.index + cut[0].length) };
}

/** A GraphQL answer: partial `data` stays usable when some aliases failed (no access). */
export interface GhGraphqlAnswer {
  readonly data: Record<string, unknown>;
  readonly errors: readonly { readonly message: string }[];
}
export type GhGraphql = (query: string) => Promise<GhGraphqlAnswer>;

const GhAnswer = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** The body as JSON, or null when it is not JSON. */
function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The body's data and errors; throws when there is no data (gh or GitHub failed outright). */
function graphqlAnswer(body: string, stderr: string, budget: ProviderBudget | null): GhGraphqlAnswer {
  const parsed = GhAnswer.safeParse(jsonOf(body));
  const answer = parsed.success ? parsed.data : {};
  const errors: GhGraphqlAnswer["errors"] = answer.errors ?? [];
  if (budget !== null && errors.some((e) => GH_LIMIT.test(e.message))) budget.limited();
  if (answer.data === undefined || answer.data === null) {
    const why = errors[0]?.message ?? (stderr.trim().split("\n")[0] || "no answer");
    throw new Error(`gh api graphql failed: ${why.slice(0, 200)}`);
  }
  return { data: answer.data, errors };
}

/**
 * GitHub GraphQL through `gh api graphql --include`, so the budget sees GitHub's limit headers. An
 * answer with partial data and errors (an alias without access) is returned, not thrown.
 */
export function ghGraphql(run: ToolRun, gh: string, budget: ProviderBudget | null): GhGraphql {
  return async (query) => {
    budget?.take();
    const res = await run([gh, "api", "graphql", "--include", "-f", `query=${query}`], { cwd: homedir(), timeoutMs: GH_TIMEOUT_MS });
    if (res.timedOut) throw new Error("gh api graphql took too long");
    const { status, headers, body } = splitIncluded(res.stdout);
    budget?.observe(status, { get: (name) => headers.get(name) ?? null });
    return graphqlAnswer(body, res.stderr, budget);
  };
}

// ---- PR actions facts (PLAN §2.6): what merge, auto-merge, request review and re-run act on ----

const LIVE_CHECKS = `contexts(first: 100) { nodes { __typename
  ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { databaseId runNumber workflow { name } } } }
  ... on StatusContext { context state targetUrl } } }`;
const LIVE_FIELDS = `state isDraft headRefOid baseRefName mergeable mergeStateStatus isInMergeQueue isMergeQueueEnabled
  mergeQueueEntry { state }
  autoMergeRequest { mergeMethod enabledBy { login } }
  latestReviews(first: 50) { nodes { author { login } state submittedAt } }
  reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { ${LIVE_CHECKS} } } } }`;

/** One PR's live merge, review and check facts with the repo's merge settings and Isaac's permission. */
export function prLiveQuery(repo: string, number: number): string {
  const [owner = "", name = ""] = repo.split("/");
  return `{ repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
  pullRequest(number: ${String(number)}) { ${LIVE_FIELDS} } } }`;
}

const GhLogin = z.object({ login: z.string() }).nullable();
const LiveCheck = z.object({
  name: z.string().optional(),
  status: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
  checkSuite: z
    .object({ workflowRun: z.object({ databaseId: z.number(), runNumber: z.number(), workflow: z.object({ name: z.string() }).nullable().optional() }).nullable() })
    .nullable()
    .optional(),
  context: z.string().optional(),
  state: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
});
const LiveRepo = z.object({
  viewerPermission: z.string().nullable(),
  mergeCommitAllowed: z.boolean(),
  squashMergeAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
  pullRequest: z
    .object({
      state: z.string(),
      isDraft: z.boolean(),
      headRefOid: z.string(),
      baseRefName: z.string(),
      mergeable: z.string(),
      mergeStateStatus: z.string(),
      isInMergeQueue: z.boolean(),
      isMergeQueueEnabled: z.boolean(),
      mergeQueueEntry: z.object({ state: z.string() }).nullable(),
      autoMergeRequest: z.object({ mergeMethod: z.string(), enabledBy: GhLogin }).nullable(),
      latestReviews: z.object({ nodes: z.array(z.object({ author: GhLogin, state: z.string(), submittedAt: z.string().nullable() })) }),
      reviewRequests: z.object({ nodes: z.array(z.object({ requestedReviewer: z.object({ login: z.string().optional(), slug: z.string().optional() }).nullable() })) }),
      commits: z.object({
        nodes: z.array(z.object({ commit: z.object({ oid: z.string(), statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(LiveCheck) }) }).nullable() }) })),
      }),
    })
    .nullable(),
});
type LivePr = NonNullable<z.infer<typeof LiveRepo>["pullRequest"]>;

/** A PR as the gate's GitHub executor checks it and the PR page's actions show it. */
export interface PrLive {
  /** OPEN, CLOSED, MERGED. */
  readonly state: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly base: string;
  /** Logins and team slugs whose review is requested. */
  readonly requested: readonly string[];
  readonly actions: ReviewPrActions;
}

const METHODS: Record<string, PrMergeMethod> = { MERGE: "merge", SQUASH: "squash", REBASE: "rebase" };

/** A check's Actions run, when it is one. */
function runOf(c: z.infer<typeof LiveCheck>): Pick<ReviewActionCheck, "workflow" | "runId" | "runNumber"> {
  const run = c.checkSuite?.workflowRun ?? null;
  if (run === null) return { workflow: null, runId: null, runNumber: null };
  return { workflow: run.workflow?.name ?? null, runId: run.databaseId, runNumber: run.runNumber };
}

function liveChecks(pr: LivePr): ReviewActionCheck[] {
  const commit = pr.commits.nodes[0]?.commit;
  const headSha = commit?.oid ?? pr.headRefOid;
  return (commit?.statusCheckRollup?.contexts.nodes ?? []).map((c) => ({
    name: c.name ?? c.context ?? "check",
    state: checkState(c),
    url: c.detailsUrl ?? c.targetUrl ?? null,
    ...runOf(c),
    attempt: null,
    headSha,
  }));
}

function liveActions(repo: z.infer<typeof LiveRepo>, pr: LivePr): ReviewPrActions {
  const auto = pr.autoMergeRequest;
  return {
    viewerPermission: repo.viewerPermission,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    methods: { merge: repo.mergeCommitAllowed, squash: repo.squashMergeAllowed, rebase: repo.rebaseMergeAllowed },
    autoMerge: auto === null ? null : { method: METHODS[auto.mergeMethod] ?? "merge", by: auto.enabledBy?.login ?? null },
    mergeQueue: { required: pr.isMergeQueueEnabled, inQueue: pr.isInMergeQueue, entryState: pr.mergeQueueEntry?.state ?? null },
    reviews: pr.latestReviews.nodes.map((r) => ({ login: r.author?.login ?? "ghost", state: r.state, at: ms(r.submittedAt) })),
    checks: liveChecks(pr),
  };
}

/** The PR's live facts; null when the repo or PR doesn't resolve for gh's account. Throws when GitHub can't say. */
export async function readPrLive(graphql: GhGraphql, repo: string, number: number): Promise<PrLive | null> {
  const { data, errors } = await graphql(prLiveQuery(repo, number));
  const parsed = LiveRepo.nullable().safeParse(data["repository"] ?? null);
  if (!parsed.success) throw new Error(`GitHub answered something else for ${repo}#${String(number)}${errors[0] === undefined ? "" : `: ${errors[0].message}`}`);
  const pr = parsed.data?.pullRequest ?? null;
  if (parsed.data === null || pr === null) return null;
  return {
    state: pr.state,
    draft: pr.isDraft,
    headSha: pr.headRefOid,
    base: pr.baseRefName,
    requested: pr.reviewRequests.nodes.flatMap((r) => [r.requestedReviewer?.login ?? r.requestedReviewer?.slug ?? ""].filter((l) => l !== "")),
    actions: liveActions(parsed.data, pr),
  };
}

export class GitHub {
  constructor(
    private readonly run: ToolRun,
    private readonly gh: string,
    /** Where PR images are kept and how they are fetched; without it bodies stay as GitHub wrote them. */
    private readonly images?: { media: ReviewMedia; fetchFn: Fetch; linearKey: () => string | null },
    /** The GitHub budget shared with the tickets sync; null: unpaced. */
    private readonly budget: ProviderBudget | null = null,
  ) {}

  private call(args: readonly string[]): Promise<string> {
    return ghCall(this.run, this.gh, this.budget, args);
  }

  private async search(q: string, perPage: number): Promise<{ total: number; items: SearchItem[] }> {
    const out = await this.call(["api", "-X", "GET", "search/issues", "-f", `q=is:pr org:${REVIEWS_ORG} ${q}`, "-f", `per_page=${String(perPage)}`, "-f", "sort=updated"]);
    const body = JSON.parse(out) as { total_count: number; items: SearchItem[] };
    return { total: body.total_count, items: body.items };
  }

  /** The PRs waiting on his review, then the ones he reviewed that moved since. */
  async queue(): Promise<ReviewItem[]> {
    const [needs, reviewing] = await Promise.all([
      this.search("is:open review-requested:@me", 50),
      this.search("is:open reviewed-by:@me -author:@me -review-requested:@me", 50),
    ]);
    return [...needs.items.map((i) => toItem(i, "needs")), ...reviewing.items.map((i) => toItem(i, "reviewing"))];
  }

  /** Relay Desktop's other views: closed PRs he reviewed (20 and a count), or open PRs he wrote. */
  async list(list: "completed" | "created"): Promise<{ items: ReviewItem[]; total: number }> {
    const found = list === "completed" ? await this.search("reviewed-by:@me -author:@me is:closed", 20) : await this.search("is:open author:@me", 50);
    return { items: found.items.map((i) => toItem(i, list)), total: found.total };
  }

  /** `gh pr view --json PR_VIEW_FIELDS`, as gh wrote it. */
  async view(repo: string, number: number): Promise<Record<string, unknown>> {
    const out = await this.call(["pr", "view", String(number), "-R", repo, "--json", PR_VIEW_FIELDS]);
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("gh pr view answered something else");
    return parsed as Record<string, unknown>;
  }

  async pr(repo: string, number: number): Promise<ReviewPr> {
    const [view, diff, actions] = await Promise.all([
      this.call(["pr", "view", String(number), "-R", repo, "--json", PR_JSON_FIELDS]),
      this.call(["pr", "diff", String(number), "-R", repo, "--color=never"]),
      this.actions(repo, number),
    ]);
    const pr = { ...toPr(repo, JSON.parse(view) as RawPr, diff), ...(actions === null ? {} : { actions }) };
    if (this.images === undefined) return pr;
    // GitHub's attachments open only signed in, and its `<img>` tags become markdown; PR bodies
    // carry Linear proof screenshots too.
    const { media, fetchFn, linearKey } = this.images;
    const sources = [
      { match: isGithubUpload, headers: () => this.authHeader() },
      { match: isLinearUpload, headers: () => Promise.resolve(((key) => (key ? { authorization: key } : {}))(linearKey())) },
    ];
    const local = (md: string): Promise<string> => localizeImages(md, media, sources, fetchFn);
    const [body, timeline] = await Promise.all([
      local(pr.body),
      Promise.all(pr.timeline.map(async (t) => (t.kind === "commit" ? t : { ...t, body: await local(t.body) }))),
    ]);
    return { ...pr, body, timeline };
  }

  /** The PR's actions facts, each failed Actions run with its attempt; null when GitHub can't say (the page then hides the actions). */
  private async actions(repo: string, number: number): Promise<ReviewPrActions | null> {
    try {
      const live = await readPrLive(ghGraphql(this.run, this.gh, this.budget), repo, number);
      if (live === null) return null;
      const failed = [...new Set(live.actions.checks.flatMap((c) => (c.state === "fail" && c.runId !== null ? [c.runId] : [])))].slice(0, MAX_ATTEMPT_READS);
      const attempts = new Map(await Promise.all(failed.map(async (id) => [id, await this.runAttempt(repo, id)] as const)));
      const checks = live.actions.checks.map((c) => (c.runId === null ? c : { ...c, attempt: attempts.get(c.runId) ?? null }));
      return { ...live.actions, checks };
    } catch {
      return null;
    }
  }

  /** An Actions run's attempt (REST; GraphQL has none); null when gh can't say. */
  private async runAttempt(repo: string, id: number): Promise<number | null> {
    const out = await this.call(["api", `repos/${repo}/actions/runs/${String(id)}`, "--jq", ".run_attempt"]).catch(() => "");
    const attempt = Number(out.trim());
    return Number.isInteger(attempt) && attempt > 0 ? attempt : null;
  }

  private token: Promise<string | null> | null = null;

  /** gh's login as a header, asked once (`gh auth token`); none when gh can't say. */
  private async authHeader(): Promise<Record<string, string>> {
    this.token ??= this.call(["auth", "token"]).then(
      (out) => out.trim() || null,
      () => null,
    );
    const t = await this.token;
    if (t === null) this.token = null;
    return t === null ? {} : { authorization: `token ${t}` };
  }

  async guideInput(repo: string, number: number): Promise<GuidePr> {
    const [view, diff] = await Promise.all([
      this.call(["pr", "view", String(number), "-R", repo, "--json", "title,body,files,headRefOid"]),
      this.call(["pr", "diff", String(number), "-R", repo, "--color=never"]),
    ]);
    return { ...GuidePr.parse(JSON.parse(view)), diff };
  }

  /** Posts exactly `body`; answers where it landed. */
  async comment(repo: string, number: number, body: string): Promise<string> {
    return (await this.call(["pr", "comment", String(number), "-R", repo, "--body", body])).trim();
  }

  async review(repo: string, number: number, event: "approve" | "request-changes" | "comment", body: string): Promise<void> {
    const flag = { approve: "--approve", "request-changes": "--request-changes", comment: "--comment" }[event];
    await this.call(["pr", "review", String(number), "-R", repo, flag, ...(body.trim() ? ["--body", body] : [])]);
  }
}
