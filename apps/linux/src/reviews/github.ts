// GitHub in Reviews: Isaac's review queue in the eCardSystems org and one PR's detail, read with
// `gh` (evaos-electron reviews-ipc.ts). Writes leave only on an explicit, confirmed action: a PR
// comment or a review.

import { homedir } from "node:os";
import { MAX_REVIEW_DIFF, PR_VIEW_FIELDS, type ReviewItem, type ReviewPr } from "@relay/protocol";
import { z } from "zod";
import type { ProviderBudget } from "../tickets/budget";
import type { ToolRun } from "./exec";
import type { Fetch, ReviewMedia } from "./linear";
import { isGithubUpload, isLinearUpload, localizeImages } from "./media";

export const REVIEWS_ORG = "eCardSystems";
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
  baseRefOid: string;
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
  "number,title,url,state,isDraft,author,createdAt,updatedAt,body,baseRefName,headRefName,headRefOid,baseRefOid,additions,deletions,commits,files,reviewRequests,latestReviews,reviews,comments,assignees,labels,milestone,projectItems,statusCheckRollup";

const PASSED = ["SUCCESS", "NEUTRAL"];
const FAILED = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

function checkState(c: RawPr["statusCheckRollup"][number]): ReviewPr["checks"][number]["state"] {
  const v = ([c.conclusion, c.state].find((s) => s !== null && s !== undefined && s !== "") ?? "").toUpperCase();
  if (v === "SKIPPED") return "skipped";
  if (PASSED.includes(v)) return "pass";
  if (FAILED.includes(v)) return "fail";
  return "pending";
}

const CHECK_ORDER = ["fail", "pending", "pass", "skipped"];

/** `gh pr view --json PR_JSON_FIELDS` plus its diff at `baseRefOid...headRefOid` as the protocol's PR; pushed commits join the timeline. */
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
    baseSha: raw.baseRefOid,
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
    diff: snapshotDiff(diff),
    diffTruncated: diff.length > MAX_REVIEW_DIFF,
  };
}

/** The diff a PR detail and its Guide both read: cut at `MAX_REVIEW_DIFF`, so a Guide cites only what the Diff tab has. */
export function snapshotDiff(diff: string): string {
  return diff.length > MAX_REVIEW_DIFF ? diff.slice(0, MAX_REVIEW_DIFF) : diff;
}

const SHA = /^[0-9a-f]{40}$/;

/** What the Guide is written from. */
const GuidePr = z.object({
  title: z.string(),
  body: z.string(),
  headRefOid: z.string(),
  baseRefOid: z.string(),
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

  /**
   * The PR's unified diff at exactly `base...head` (what its Files tab shows for those commits), so
   * the metadata read with the two commits and the diff can't come from different pushes.
   */
  private diffAt(repo: string, base: string, head: string): Promise<string> {
    if (!SHA.test(base) || !SHA.test(head)) return Promise.reject(new Error("gh pr view answered no base or head commit"));
    return this.call(["api", `repos/${repo}/compare/${base}...${head}`, "-H", "Accept: application/vnd.github.diff"]);
  }

  async pr(repo: string, number: number): Promise<ReviewPr> {
    const raw = JSON.parse(await this.call(["pr", "view", String(number), "-R", repo, "--json", PR_JSON_FIELDS])) as RawPr;
    const pr = toPr(repo, raw, await this.diffAt(repo, raw.baseRefOid, raw.headRefOid));
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

  /** The Guide's input from one snapshot: title, body and files with the two commits, then the diff at exactly those. */
  async guideInput(repo: string, number: number): Promise<GuidePr> {
    const view = GuidePr.parse(JSON.parse(await this.call(["pr", "view", String(number), "-R", repo, "--json", "title,body,files,headRefOid,baseRefOid"])));
    return { ...view, diff: snapshotDiff(await this.diffAt(repo, view.baseRefOid, view.headRefOid)) };
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
