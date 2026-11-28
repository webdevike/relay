// GitHub PR writes as Isaac (PLAN §2.6, §5): the MutationGate's GitHub executor, built per op over a
// gh pinned to one credential (the gate's GithubPin), so check, write and reconcile all act as the
// login the device saw. check() re-reads the PR and the target and refuses when the write no longer
// applies (another head or base than the one Isaac saw, a PR GitHub won't merge right now, a draft,
// no permission, a method the repo turned off, a comment on another PR); its revision binds the
// approval to head and base, and its confirm shows the exact text. run() is one exact `gh` argv per
// kind and never the admin override, and every one of them asks `guard` (is the pinned credential
// still the host's?) immediately before it goes out, after any read the op made first. A merge is
// REST `PUT /repos/{repo}/pulls/{n}/merge` with the reviewed head as `sha`: GitHub merges exactly
// that head at once or refuses (a push, a merge queue, not mergeable), and REST has no auto-merge or
// queue to fall back to. Never `gh pr merge`, which turns auto-merge on by itself on a queue branch.
// reconcile() only reads GitHub back after a lost response (the gate never sends a GitHub write
// twice on its own). A refusal reaches clients in the host's words, never gh's stderr.

import { homedir } from "node:os";
import type { PrMutation } from "@relay/protocol";
import { z } from "zod";
import type { ProviderBudget } from "../tickets/budget";
import { ProviderRejected } from "../tickets/errors";
import type { CheckResult, MutationExecutor } from "../tickets/gate";
import type { OpResult } from "../tickets/ops-store";
import type { ToolRun } from "./exec";
import { ghCall, readPrLive, type GhGraphql, type PrLive } from "./github";

const GH_WRITE_TIMEOUT_MS = 60_000;
/** GitHub's clock against the host's: a comment this much before the op started may still be it. */
const CLOCK_SKEW_MS = 60_000;
/** gh's stderr when the request never got an answer (the write may have happened). */
const LOST = /timed? ?out|timeout|connect|connection|EOF|TLS|network|i\/o|reset by peer|\b50[234]\b/i;
/** gh's stderr for a comment id that doesn't resolve. */
const NOT_FOUND = /HTTP 404|Not Found/;

type Kind = PrMutation["kind"];
type Of<K extends Kind> = Extract<PrMutation, { kind: K }>;
type Reconciled = "done" | "notDone" | "unknown";
type Refusal = Extract<CheckResult, { ok: false }>;

const prKey = (m: { repo: string; number: number }): string => `${m.repo}#${String(m.number)}`;
const short = (sha: string): string => sha.slice(0, 7);
const conflict = (message: string): Refusal => ({ ok: false, code: "conflict", message });
const invalid = (message: string): Refusal => ({ ok: false, code: "invalid", message });
/** `repo#n (Title)`: how a confirm names the PR, by what GitHub says now. */
const named = (m: { repo: string; number: number }, pr: PrLive): string => `${prKey(m)} (${pr.title})`;

/** The pinned gh credential or account changed before a write went out: that write was not sent. */
export class StaleGithubCredential extends ProviderRejected {
  constructor() {
    super("reviews: GitHub credential changed before the write", "The host's GitHub sign-in or account changed while writing. Reload and try again.");
  }
}

// ---- gh ----

export interface GithubWritesDeps {
  /** gh pinned to the op's credential (every call of the op runs with exactly that token). */
  readonly run: ToolRun;
  readonly gh: string;
  /** GitHub's GraphQL through the pinned gh and the shared budget (reads). */
  readonly graphql: GhGraphql;
  /** The shared GitHub budget for REST reads; writes are Isaac's own taps and are not paced. */
  readonly budget: ProviderBudget | null;
  /** The pinned gh login: Isaac's reactions and comments are found by it, and confirms name it. */
  readonly login: () => string;
  /** Asked immediately before every write; throws StaleGithubCredential when the pin is no longer the host's. */
  readonly guard: () => Promise<void>;
}

/** What a refused write says to clients, per gh command (never gh's own stderr). */
const REFUSED: Record<string, string> = {
  "pr edit": "GitHub refused the review request; nothing was changed.",
  "pr comment": "GitHub refused the comment; nothing was posted.",
  "run rerun": "GitHub refused the re-run; nothing was started.",
};
const MERGE_REFUSED = "GitHub refused the merge; nothing was merged. Check the PR on GitHub.";

/**
 * One write, after the pin check; a refusal GitHub answered is ProviderRejected (nothing written,
 * `refused` or the command's line for clients), anything else a lost response.
 */
async function ghWrite(d: GithubWritesDeps, args: readonly string[], refused?: string): Promise<string> {
  await d.guard();
  const res = await d.run([d.gh, ...args], { cwd: homedir(), timeoutMs: GH_WRITE_TIMEOUT_MS });
  const what = args.slice(0, 2).join(" ");
  if (res.timedOut) throw new Error(`gh ${what} took too long`);
  if (res.code === 0) return res.stdout;
  const why = (res.stderr.trim().split("\n")[0] ?? "").slice(0, 300);
  const message = `gh ${what} failed${why === "" ? "" : `: ${why}`}`;
  if (LOST.test(res.stderr)) throw new Error(message);
  throw new ProviderRejected(message, refused ?? REFUSED[what] ?? "GitHub refused the change; nothing was written.");
}

const read = (d: GithubWritesDeps, args: readonly string[]): Promise<string> => ghCall(d.run, d.gh, d.budget, args);

/** `--jq` lines of JSON objects as values. */
function jsonLines<T>(out: string, schema: z.ZodType<T>): T[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      const parsed = schema.safeParse(JSON.parse(l));
      return parsed.success ? [parsed.data] : [];
    });
}

// ---- Merge ----

/** GitHub merges these at once. */
const MERGEABLE_NOW = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const WRITERS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
const BLOCKED_WHY: Record<string, string> = {
  BLOCKED: "Required reviews or checks haven't passed yet",
  BEHIND: "The branch is behind its base",
  DIRTY: "It has merge conflicts",
  DRAFT: "It is a draft",
  UNKNOWN: "GitHub is still working out whether it can merge. Try again in a moment.",
};

type MergeRule = (pr: PrLive, m: Of<"merge">) => Refusal | null;

/** In order: the first that applies refuses. Only a merge GitHub makes right now, at the head Isaac saw. */
const MERGE_RULES: readonly MergeRule[] = [
  (pr) => (pr.state === "MERGED" ? conflict("This PR is already merged") : null),
  (pr) => (pr.state !== "OPEN" ? invalid("This PR is closed") : null),
  (pr, m) => (pr.headSha !== m.expectHead ? conflict(`New commits since you looked (now ${short(pr.headSha)}). Check them and confirm again.`) : null),
  (pr, m) => (pr.base !== m.expectBase ? conflict(`It now merges into ${pr.base}, not ${m.expectBase}. Check it and confirm again.`) : null),
  (pr) => (pr.draft ? invalid("This PR is a draft. Mark it ready for review first.") : null),
  (pr, m) => (WRITERS.has(pr.actions.viewerPermission ?? "") ? null : invalid(`Your GitHub account can't merge in ${m.repo}`)),
  (pr) => (pr.actions.mergeQueue.inQueue ? conflict("This PR is already in the merge queue") : null),
  // A queue merges later at whatever head the PR has then; Relay only merges at once (GitHub refuses that on a queue branch too).
  (pr) => (pr.actions.mergeQueue.required ? invalid("This branch merges through a merge queue. Add it to the queue on GitHub.") : null),
  (pr, m) => (pr.actions.methods[m.method] ? null : invalid(`${m.method} merges are off in ${m.repo}`)),
  (pr) => (pr.actions.mergeable === "CONFLICTING" ? invalid("It has merge conflicts") : null),
  (pr) => (MERGEABLE_NOW.has(pr.actions.mergeStateStatus) ? null : invalid(BLOCKED_WHY[pr.actions.mergeStateStatus] ?? `GitHub won't merge it yet (${pr.actions.mergeStateStatus})`)),
];

/** The approval binds head and base: a push, a retarget, or a PR GitHub no longer merges now refuses at commit. */
function checkMerge(pr: PrLive, m: Of<"merge">): CheckResult {
  for (const rule of MERGE_RULES) {
    const refused = rule(pr, m);
    if (refused !== null) return refused;
  }
  return { ok: true, revision: `${pr.headSha}|${pr.base}`, summary: `Merge now: ${named(m, pr)} at ${short(pr.headSha)} into ${pr.base} (${m.method})` };
}

const Merged = z.object({ merged: z.boolean() });

/**
 * An immediate merge of exactly the head Isaac confirmed (REST `sha`; never --auto or --admin). A
 * queue added, a push or anything else since the check is GitHub's refusal; nothing waits to merge later.
 */
async function runMerge(d: GithubWritesDeps, m: Of<"merge">): Promise<OpResult> {
  const args = ["api", "-X", "PUT", `repos/${m.repo}/pulls/${String(m.number)}/merge`, "-f", `sha=${m.expectHead}`, "-f", `merge_method=${m.method}`];
  const answer = Merged.safeParse(JSON.parse(await ghWrite(d, args, MERGE_REFUSED)));
  if (!answer.success || !answer.data.merged) throw new Error("GitHub didn't say it merged");
  return { merge: "merged" };
}

async function reconcileMerge(d: GithubWritesDeps, m: Of<"merge">): Promise<Reconciled> {
  const pr = await readPrLive(d.graphql, m.repo, m.number);
  if (pr === null) return "unknown";
  return pr.state === "MERGED" ? "done" : "notDone";
}

// ---- Re-run ----

const RunFacts = z.object({ head_sha: z.string(), conclusion: z.string().nullable(), run_attempt: z.number() });

async function runFacts(d: GithubWritesDeps, m: Of<"rerun">): Promise<z.infer<typeof RunFacts>> {
  return RunFacts.parse(JSON.parse(await read(d, ["api", `repos/${m.repo}/actions/runs/${String(m.runId)}`])));
}

async function checkRerun(d: GithubWritesDeps, pr: PrLive, m: Of<"rerun">): Promise<CheckResult> {
  if (pr.state !== "OPEN") return invalid("This PR is closed");
  if (pr.headSha !== m.headSha) return conflict(`New commits since you looked (now ${short(pr.headSha)})`);
  const run = await runFacts(d, m);
  if (run.head_sha !== pr.headSha) return invalid("That run isn't for this PR's head commit");
  if (run.conclusion !== "failure") return invalid(run.conclusion === null ? "That run is still going" : "That run didn't fail");
  if (run.run_attempt !== m.attempt) return conflict("That run was already re-run");
  return { ok: true, revision: `${String(m.runId)}:${String(run.run_attempt)}`, summary: `Re-run failed jobs of run ${String(m.runId)} on ${named(m, pr)}` };
}

// ---- Comments on the PR (targets) ----

const PrComment = z.object({
  pr: z.string().nullable().optional(),
  issue: z.string().nullable().optional(),
  reply: z.number().nullable().optional(),
  author: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
});
type PrComment = z.infer<typeof PrComment>;

/**
 * A conversation or review comment, only when it is on this PR (GitHub's own `issue_url` /
 * `pull_request_url` for it); null when it doesn't resolve or belongs to another PR.
 */
async function commentOn(d: GithubWritesDeps, m: { repo: string; number: number }, kind: "issueComment" | "reviewComment", id: number): Promise<PrComment | null> {
  const where = kind === "issueComment" ? "issues" : "pulls";
  const jq = "{pr: .pull_request_url, issue: .issue_url, reply: .in_reply_to_id, author: .user.login, path}";
  let out: string;
  try {
    out = await read(d, ["api", `repos/${m.repo}/${where}/comments/${String(id)}`, "--jq", jq]);
  } catch (error) {
    if (error instanceof Error && NOT_FOUND.test(error.message)) return null;
    throw error;
  }
  const parsed = PrComment.safeParse(JSON.parse(out));
  if (!parsed.success) return null;
  const url = (kind === "issueComment" ? parsed.data.issue : parsed.data.pr) ?? "";
  return url.toLowerCase().endsWith(`/repos/${m.repo}/${where}/${String(m.number)}`.toLowerCase()) ? parsed.data : null;
}

const NOT_ON_PR = "That comment isn't on this PR (or was deleted)";

// ---- Reactions ----

function reactionsPath(m: Of<"react">): string {
  const t = m.target;
  if (t.kind === "prBody") return `repos/${m.repo}/issues/${String(m.number)}/reactions`;
  return `repos/${m.repo}/${t.kind === "issueComment" ? "issues" : "pulls"}/comments/${String(t.id)}/reactions`;
}

async function checkReact(d: GithubWritesDeps, pr: PrLive, m: Of<"react">): Promise<CheckResult> {
  const t = m.target;
  const what = `${m.on ? "React" : "Remove reaction"} :${m.emoji}:`;
  if (t.kind === "prBody") return { ok: true, revision: "-", summary: `${what} on ${named(m, pr)}` };
  const comment = await commentOn(d, m, t.kind, t.id);
  if (comment === null) return invalid(NOT_ON_PR);
  return { ok: true, revision: "-", summary: `${what} on ${comment.author ?? "a"}'s comment in ${named(m, pr)}` };
}

const Reaction = z.object({ id: z.number(), login: z.string().nullable() });

/** Isaac's reaction of that emoji's id, null when he has none. Throws when it can't tell. */
async function myReaction(d: GithubWritesDeps, m: Of<"react">): Promise<number | null> {
  const login = d.login();
  const out = await read(d, ["api", "-X", "GET", reactionsPath(m), "-f", `content=${m.emoji}`, "-f", "per_page=100", "--paginate", "--jq", ".[] | {id, login: .user.login}"]);
  return jsonLines(out, Reaction).find((r) => r.login?.toLowerCase() === login.toLowerCase())?.id ?? null;
}

async function runReact(d: GithubWritesDeps, m: Of<"react">): Promise<OpResult> {
  const mine = await myReaction(d, m);
  if (m.on && mine === null) await ghWrite(d, ["api", "-X", "POST", reactionsPath(m), "-f", `content=${m.emoji}`]);
  if (!m.on && mine !== null) await ghWrite(d, ["api", "-X", "DELETE", `${reactionsPath(m)}/${String(mine)}`]);
  return {};
}

// ---- Comments ----

function checkComment(d: GithubWritesDeps, pr: PrLive, m: Of<"comment">): CheckResult {
  return { ok: true, revision: "-", summary: `Comment on ${named(m, pr)} as ${d.login()}`, text: m.body };
}

/** A new line thread binds to the head Isaac commented on: after a push he looks again. */
function checkReviewComment(d: GithubWritesDeps, pr: PrLive, m: Of<"reviewComment">): CheckResult {
  if (pr.headSha !== m.commitId) return conflict(`New commits since you looked (now ${short(pr.headSha)}). Check them and comment again.`);
  const side = m.side === "LEFT" ? "old" : "new";
  return { ok: true, revision: pr.headSha, summary: `Comment on ${m.path} line ${String(m.line)} (${side}) of ${named(m, pr)} at ${short(pr.headSha)} as ${d.login()}`, text: m.body };
}

/** A reply goes to a thread's root on this PR, named by its author and file. */
async function checkReviewReply(d: GithubWritesDeps, pr: PrLive, m: Of<"reviewReply">): Promise<CheckResult> {
  const root = await commentOn(d, m, "reviewComment", m.commentId);
  if (root === null) return invalid(NOT_ON_PR);
  if (root.reply != null) return invalid("Reply to the first comment of the thread");
  return { ok: true, revision: "-", summary: `Reply to ${root.author ?? "a"}'s thread on ${root.path ?? "a file"} in ${named(m, pr)} as ${d.login()}`, text: m.body };
}

const Posted = z.object({ id: z.number(), html_url: z.string() });
const Listed = z.object({
  id: z.number(),
  login: z.string().nullable(),
  body: z.string(),
  created_at: z.string(),
  url: z.string(),
  path: z.string().nullable().optional(),
  reply: z.number().nullable().optional(),
});
type ListedComment = z.infer<typeof Listed>;

function postedResult(out: string): OpResult {
  const posted = Posted.safeParse(JSON.parse(out));
  return posted.success ? { id: String(posted.data.id), url: posted.data.html_url } : {};
}

/** Isaac's comments on the PR since the op started (conversation, or review comments for line kinds). */
async function myCommentsSince(d: GithubWritesDeps, m: Of<"comment" | "reviewComment" | "reviewReply">, startedAt: number): Promise<ListedComment[]> {
  const login = d.login();
  const since = new Date(startedAt - CLOCK_SKEW_MS).toISOString();
  const where = m.kind === "comment" ? `repos/${m.repo}/issues/${String(m.number)}/comments` : `repos/${m.repo}/pulls/${String(m.number)}/comments`;
  const jq = ".[] | {id, login: .user.login, body, created_at, url: .html_url, path, reply: .in_reply_to_id}";
  const out = await read(d, ["api", "-X", "GET", where, "-f", `since=${since}`, "-f", "per_page=100", "--paginate", "--jq", jq]);
  return jsonLines(out, Listed).filter((c) => c.login?.toLowerCase() === login.toLowerCase() && Date.parse(c.created_at) >= startedAt - CLOCK_SKEW_MS);
}

function sameComment(m: Of<"comment" | "reviewComment" | "reviewReply">, c: ListedComment): boolean {
  if (c.body !== m.body) return false;
  if (m.kind === "reviewComment") return c.path === m.path;
  return m.kind === "reviewReply" ? c.reply === m.commentId : true;
}

async function reconcileComment(d: GithubWritesDeps, m: Of<"comment" | "reviewComment" | "reviewReply">, startedAt: number): Promise<Reconciled> {
  const mine = await myCommentsSince(d, m, startedAt);
  return mine.some((c) => sameComment(m, c)) ? "done" : "notDone";
}

// ---- The executor ----

type Checks = { [K in Kind]: (d: GithubWritesDeps, pr: PrLive, m: Of<K>) => CheckResult | Promise<CheckResult> };
type Runs = { [K in Kind]: (d: GithubWritesDeps, m: Of<K>) => Promise<OpResult> };
type Reconciles = { [K in Kind]: (d: GithubWritesDeps, m: Of<K>, startedAt: number) => Promise<Reconciled> };

const CHECKS: Checks = {
  merge: (_d, pr, m) => checkMerge(pr, m),
  rerun: checkRerun,
  requestReview: (_d, pr, m) => (pr.state === "OPEN" ? { ok: true, revision: `${pr.headSha}|${pr.base}`, summary: `Ask ${m.logins.join(", ")} to review ${named(m, pr)}` } : invalid("This PR is closed")),
  react: checkReact,
  comment: checkComment,
  reviewComment: checkReviewComment,
  reviewReply: checkReviewReply,
};

const RUNS: Runs = {
  merge: runMerge,
  rerun: async (d, m) => {
    await ghWrite(d, ["run", "rerun", String(m.runId), "--failed", "--repo", m.repo]);
    return {};
  },
  requestReview: async (d, m) => {
    await ghWrite(d, ["pr", "edit", String(m.number), "--repo", m.repo, "--add-reviewer", m.logins.join(",")]);
    return {};
  },
  react: runReact,
  comment: async (d, m) => ({ url: (await ghWrite(d, ["pr", "comment", String(m.number), "--repo", m.repo, "--body", m.body])).trim() }),
  reviewComment: async (d, m) => {
    const fields = ["-f", `body=${m.body}`, "-f", `commit_id=${m.commitId}`, "-f", `path=${m.path}`, "-F", `line=${String(m.line)}`, "-f", `side=${m.side}`];
    return postedResult(await ghWrite(d, ["api", `repos/${m.repo}/pulls/${String(m.number)}/comments`, ...fields]));
  },
  reviewReply: async (d, m) => postedResult(await ghWrite(d, ["api", `repos/${m.repo}/pulls/${String(m.number)}/comments/${String(m.commentId)}/replies`, "-f", `body=${m.body}`])),
};

const RECONCILES: Reconciles = {
  merge: reconcileMerge,
  rerun: async (d, m) => ((await runFacts(d, m)).run_attempt > m.attempt ? "done" : "notDone"),
  requestReview: async (d, m) => {
    const pr = await readPrLive(d.graphql, m.repo, m.number);
    if (pr === null) return "unknown";
    const seen = new Set([...pr.requested, ...pr.actions.reviews.map((r) => r.login)].map((l) => l.toLowerCase()));
    return m.logins.every((l) => seen.has(l.toLowerCase())) ? "done" : "notDone";
  },
  react: async (d, m) => ((await myReaction(d, m)) !== null) === m.on ? "done" : "notDone",
  comment: reconcileComment,
  reviewComment: reconcileComment,
  reviewReply: reconcileComment,
};

export function githubExecutor(d: GithubWritesDeps): MutationExecutor<PrMutation> {
  // One dispatch per kind: each table entry takes its own kind's mutation.
  return {
    async check(m) {
      const pr = await readPrLive(d.graphql, m.repo, m.number);
      if (pr === null) return invalid(`${prKey(m)} isn't on GitHub or this account can't see it`);
      return (CHECKS[m.kind] as (d: GithubWritesDeps, pr: PrLive, m: PrMutation) => CheckResult | Promise<CheckResult>)(d, pr, m);
    },
    run: (m) => (RUNS[m.kind] as (d: GithubWritesDeps, m: PrMutation) => Promise<OpResult>)(d, m),
    reconcile: (m, _opId, startedAt) => (RECONCILES[m.kind] as (d: GithubWritesDeps, m: PrMutation, startedAt: number) => Promise<Reconciled>)(d, m, startedAt),
  };
}
