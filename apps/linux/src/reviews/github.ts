// GitHub in Reviews: Isaac's review queue in the eCardSystems org and one PR's detail, read with
// `gh` (evaos-electron reviews-ipc.ts). Writes leave only on an explicit, confirmed action: a PR
// comment or a review.

import { homedir } from "node:os";
import { MAX_REVIEW_DIFF, type ReviewItem, type ReviewPr } from "@relay/protocol";
import { z } from "zod";
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

/** A search row as a queue row: `needs` (his review is requested) or `reviewing` (he reviewed, it moved). */
export function toItem(item: SearchItem, group: "needs" | "reviewing"): ReviewItem {
  return {
    url: item.html_url,
    ref: { kind: "github", repo: item.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, ""), number: item.number },
    title: item.title,
    actor: item.user?.login ?? "ghost",
    reason: group === "needs" ? "requested your review" : "updated since your review",
    label: `#${String(item.number)}`,
    updatedAt: ms(item.updated_at),
    unread: true,
    draft: item.draft === true,
    group,
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
  "number,title,url,state,isDraft,author,createdAt,updatedAt,body,baseRefName,headRefName,headRefOid,additions,deletions,commits,files,reviewRequests,latestReviews,reviews,comments,assignees,labels,statusCheckRollup";

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

export class GitHub {
  constructor(
    private readonly run: ToolRun,
    private readonly gh: string,
    /** Where PR images are kept and how they are fetched; without it bodies stay as GitHub wrote them. */
    private readonly images?: { media: ReviewMedia; fetchFn: Fetch; linearKey: () => string | null },
  ) {}

  private async call(args: readonly string[]): Promise<string> {
    const res = await this.run([this.gh, ...args], { cwd: homedir(), timeoutMs: GH_TIMEOUT_MS });
    if (res.timedOut) throw new Error(`gh ${args.slice(0, 2).join(" ")} took too long`);
    if (res.code !== 0) {
      const why = res.stderr.trim().split("\n")[0] ?? "";
      throw new Error(`gh ${args.slice(0, 2).join(" ")} failed${why === "" ? "" : `: ${why.slice(0, 200)}`}`);
    }
    return res.stdout;
  }

  private async search(q: string, group: "needs" | "reviewing"): Promise<ReviewItem[]> {
    const out = await this.call(["api", "-X", "GET", "search/issues", "-f", `q=is:pr org:${REVIEWS_ORG} ${q}`, "-f", "per_page=50", "-f", "sort=updated"]);
    const body = JSON.parse(out) as { items: SearchItem[] };
    return body.items.map((item) => toItem(item, group));
  }

  /** The PRs waiting on his review, then the ones he reviewed that moved since. */
  async queue(): Promise<ReviewItem[]> {
    const [needs, reviewing] = await Promise.all([
      this.search("is:open review-requested:@me", "needs"),
      this.search("is:open reviewed-by:@me -author:@me -review-requested:@me", "reviewing"),
    ]);
    return [...needs, ...reviewing];
  }

  async pr(repo: string, number: number): Promise<ReviewPr> {
    const [view, diff] = await Promise.all([
      this.call(["pr", "view", String(number), "-R", repo, "--json", PR_JSON_FIELDS]),
      this.call(["pr", "diff", String(number), "-R", repo, "--color=never"]),
    ]);
    const pr = toPr(repo, JSON.parse(view) as RawPr, diff);
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
