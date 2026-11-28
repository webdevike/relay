// GitHub PR writes as Isaac (PLAN §2.6, §5): the MutationGate's GitHub executor. check() re-reads the
// PR and refuses when the write no longer applies (another head than the one Isaac saw, an outcome
// other than the one he confirmed, a draft, no permission, a method the repo turned off); run() is
// one exact `gh` argv per kind and never the admin override; reconcile() reads GitHub back after a lost
// response. Auto-merge Relay turns on is remembered with its head (`automerge.json`), so a push
// after it can turn it off again (github-sync, `relayAutoMergeWatch`).

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PrMutation } from "@relay/protocol";
import { z } from "zod";
import type { ProviderBudget } from "../tickets/budget";
import { ProviderRejected, type CheckResult, type MutationExecutor } from "../tickets/gate";
import type { AutoMergeWatch } from "../tickets/github-sync";
import type { OpResult } from "../tickets/ops-store";
import { readJson, writeJson, type ToolRun } from "./exec";
import { ghCall, readPrLive, type GhGraphql, type PrLive } from "./github";

const GH_WRITE_TIMEOUT_MS = 60_000;
/** GitHub's clock against the host's: a comment this much before the op started may still be it. */
const CLOCK_SKEW_MS = 60_000;
/** gh's stderr when the request never got an answer (the write may have happened). */
const LOST = /timed? ?out|timeout|connect|connection|EOF|TLS|network|i\/o|reset by peer|\b50[234]\b/i;

type Kind = PrMutation["kind"];
type Of<K extends Kind> = Extract<PrMutation, { kind: K }>;
type Reconciled = "done" | "notDone" | "unknown";
type Refusal = Extract<CheckResult, { ok: false }>;

const prKey = (m: { repo: string; number: number }): string => `${m.repo}#${String(m.number)}`;
const short = (sha: string): string => sha.slice(0, 7);
const conflict = (message: string): Refusal => ({ ok: false, code: "conflict", message });
const invalid = (message: string): Refusal => ({ ok: false, code: "invalid", message });

// ---- Relay-armed auto-merge ----

const AutoMergeFile = z.object({
  v: z.literal(1),
  /** `repo#n` -> the head Relay turned auto-merge on at. */
  armed: z.record(z.string(), z.string()),
  /** `repo#n` -> the head that turned it off again (Needs you: autoMergeOff). */
  disarmed: z.record(z.string(), z.string()),
});
type AutoMergeState = z.infer<typeof AutoMergeFile>;

/** `<tickets dir>/automerge.json`: the PRs whose auto-merge Relay turned on, and the ones a push turned off. */
export class RelayAutoMerge {
  private readonly file: string;
  private state: AutoMergeState;

  constructor(dir: string) {
    this.file = join(dir, "automerge.json");
    const parsed = AutoMergeFile.safeParse(readJson(this.file, null));
    this.state = parsed.success ? parsed.data : { v: 1, armed: {}, disarmed: {} };
  }

  armedHead(key: string): string | undefined {
    return this.state.armed[key];
  }

  isDisarmed(key: string): boolean {
    return this.state.disarmed[key] !== undefined;
  }

  arm(key: string, head: string): void {
    const { [key]: _was, ...disarmed } = this.state.disarmed;
    this.save({ v: 1, armed: { ...this.state.armed, [key]: head }, disarmed });
  }

  /** Isaac turned it off, or the PR closed: Relay no longer watches it. */
  forget(key: string): void {
    const { [key]: _armed, ...armed } = this.state.armed;
    const { [key]: _disarmed, ...disarmed } = this.state.disarmed;
    this.save({ v: 1, armed, disarmed });
  }

  disarm(key: string, head: string): void {
    const { [key]: _armed, ...armed } = this.state.armed;
    this.save({ v: 1, armed, disarmed: { ...this.state.disarmed, [key]: head } });
  }

  private save(next: AutoMergeState): void {
    this.state = next;
    writeJson(this.file, next);
  }
}

// ---- gh ----

export interface GithubWritesDeps {
  readonly run: ToolRun;
  readonly gh: string;
  /** GitHub's GraphQL through the shared budget (reads). */
  readonly graphql: GhGraphql;
  /** The shared GitHub budget for REST reads; writes are Isaac's own taps and are not paced. */
  readonly budget: ProviderBudget | null;
  /** gh's login the gate acts as: Isaac's reactions and comments are found by it. */
  readonly login: () => string | null;
  readonly autoMerge: RelayAutoMerge;
}

/** One write; a refusal GitHub answered is ProviderRejected (nothing written), anything else a lost response. */
async function ghWrite(d: GithubWritesDeps, args: readonly string[]): Promise<string> {
  const res = await d.run([d.gh, ...args], { cwd: homedir(), timeoutMs: GH_WRITE_TIMEOUT_MS });
  const what = `gh ${args.slice(0, 2).join(" ")}`;
  if (res.timedOut) throw new Error(`${what} took too long`);
  if (res.code === 0) return res.stdout;
  const why = (res.stderr.trim().split("\n")[0] ?? "").slice(0, 300);
  const message = `${what} failed${why === "" ? "" : `: ${why}`}`;
  throw LOST.test(res.stderr) ? new Error(message) : new ProviderRejected(message);
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

// ---- Merge and auto-merge ----

/** What a merge does now: merge at once, join the base's merge queue, or arm auto-merge. */
export type MergeOutcome = "merge" | "queue" | "auto";
const OUTCOME_WORDS: Record<MergeOutcome, string> = { merge: "Merge now", queue: "Add to merge queue", auto: "Turn on auto-merge" };
/** gh merges these at once (`--auto` too). */
const MERGEABLE_NOW = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const WRITERS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
const BLOCKED_WHY: Record<string, string> = {
  BLOCKED: "Required reviews or checks haven't passed yet",
  BEHIND: "The branch is behind its base",
  DIRTY: "It has merge conflicts",
  DRAFT: "It is a draft",
  UNKNOWN: "GitHub is still working out whether it can merge. Try again in a moment.",
};

export function mergeOutcome(pr: PrLive, intent: "merge" | "auto"): MergeOutcome {
  if (pr.actions.mergeQueue.required) return "queue";
  return intent === "merge" || MERGEABLE_NOW.has(pr.actions.mergeStateStatus) ? "merge" : "auto";
}

interface MergeAsk {
  readonly repo: string;
  readonly number: number;
  readonly method: "merge" | "squash" | "rebase";
  readonly intent: "merge" | "auto";
  readonly expectHead: string;
}
type MergeRule = (pr: PrLive, m: MergeAsk) => Refusal | null;

/** In order: the first that applies refuses. */
const MERGE_RULES: readonly MergeRule[] = [
  (pr) => (pr.state === "MERGED" ? conflict("This PR is already merged") : null),
  (pr) => (pr.state !== "OPEN" ? invalid("This PR is closed") : null),
  (pr, m) => (pr.headSha !== m.expectHead ? conflict(`New commits since you looked (now ${short(pr.headSha)}). Check them and confirm again.`) : null),
  (pr) => (pr.draft ? invalid("This PR is a draft. Mark it ready for review first.") : null),
  (pr, m) => (WRITERS.has(pr.actions.viewerPermission ?? "") ? null : invalid(`Your GitHub account can't merge in ${m.repo}`)),
  (pr, m) => (pr.actions.mergeQueue.required && m.intent === "merge" ? conflict("This branch merges through a queue; use Add to merge queue") : null),
  (pr) => (pr.actions.mergeQueue.inQueue ? conflict("This PR is already in the merge queue") : null),
  (pr, m) => (pr.actions.mergeQueue.required || pr.actions.methods[m.method] ? null : invalid(`${m.method} merges are off in ${m.repo}`)),
  (pr) => (pr.actions.mergeable === "CONFLICTING" ? invalid("It has merge conflicts") : null),
  (pr, m) => (m.intent === "merge" && !MERGEABLE_NOW.has(pr.actions.mergeStateStatus) ? invalid(BLOCKED_WHY[pr.actions.mergeStateStatus] ?? `GitHub won't merge it yet (${pr.actions.mergeStateStatus})`) : null),
];

function checkMerge(pr: PrLive, m: MergeAsk): CheckResult {
  for (const rule of MERGE_RULES) {
    const refused = rule(pr, m);
    if (refused !== null) return refused;
  }
  const outcome = mergeOutcome(pr, m.intent);
  const how = outcome === "queue" ? "" : ` (${m.method})`;
  return { ok: true, revision: `${pr.headSha}|${outcome}`, summary: `${OUTCOME_WORDS[outcome]}: ${prKey(m)} at ${short(pr.headSha)} into ${pr.base}${how}` };
}

function checkAutoMerge(pr: PrLive, m: Of<"autoMerge">): CheckResult {
  if (!m.on) return pr.state === "OPEN" ? { ok: true, revision: "off", summary: `Turn off auto-merge on ${prKey(m)}` } : invalid("This PR is closed");
  if (m.method === undefined) return invalid("Pick a merge method to turn on auto-merge");
  if (pr.actions.autoMerge !== null && pr.headSha === m.expectHead) return { ok: true, revision: `${pr.headSha}|armed`, summary: `Auto-merge is already on for ${prKey(m)}` };
  return checkMerge(pr, { ...m, method: m.method, intent: "auto" });
}

/** Where a merge stands once gh answered; Relay remembers auto-merge it armed with the head. */
async function mergeResult(d: GithubWritesDeps, m: MergeAsk): Promise<OpResult> {
  const pr = await readPrLive(d.graphql, m.repo, m.number);
  if (pr?.state === "MERGED") return { merge: "merged" };
  if (pr?.actions.mergeQueue.inQueue === true) return { merge: "queued" };
  if (pr?.actions.autoMerge == null) throw new Error("GitHub doesn't show the merge yet");
  d.autoMerge.arm(prKey(m), m.expectHead);
  return { merge: "autoMergeArmed" };
}

async function runMerge(d: GithubWritesDeps, m: MergeAsk): Promise<OpResult> {
  if (m.intent === "auto") {
    // Desired state: auto-merge already on is no write.
    const pr = await readPrLive(d.graphql, m.repo, m.number);
    if (pr?.actions.autoMerge != null) return { merge: "autoMergeArmed" };
  }
  const auto = m.intent === "auto" ? ["--auto"] : [];
  await ghWrite(d, ["pr", "merge", String(m.number), "--repo", m.repo, `--${m.method}`, "--match-head-commit", m.expectHead, ...auto]);
  return mergeResult(d, m);
}

async function runAutoMerge(d: GithubWritesDeps, m: Of<"autoMerge">): Promise<OpResult> {
  if (m.on) return runMerge(d, { ...m, method: m.method ?? "merge", intent: "auto" });
  const pr = await readPrLive(d.graphql, m.repo, m.number);
  if (pr?.actions.autoMerge != null) await ghWrite(d, ["pr", "merge", String(m.number), "--repo", m.repo, "--disable-auto"]);
  d.autoMerge.forget(prKey(m));
  return {};
}

async function reconcileMerge(d: GithubWritesDeps, m: Of<"merge"> | Of<"autoMerge">): Promise<Reconciled> {
  const pr = await readPrLive(d.graphql, m.repo, m.number);
  if (pr === null) return "unknown";
  const off = m.kind === "autoMerge" && !m.on;
  if (off) return pr.actions.autoMerge === null ? "done" : "notDone";
  const landed = pr.state === "MERGED" || pr.actions.mergeQueue.inQueue;
  const armed = m.kind === "autoMerge" || m.intent === "auto" ? pr.actions.autoMerge !== null : false;
  return landed || armed ? "done" : "notDone";
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
  return { ok: true, revision: `${String(m.runId)}:${String(run.run_attempt)}`, summary: `Re-run failed jobs of run ${String(m.runId)} on ${prKey(m)}` };
}

// ---- Reactions ----

function reactionsPath(m: Of<"react">): string {
  const t = m.target;
  if (t.kind === "prBody") return `repos/${m.repo}/issues/${String(m.number)}/reactions`;
  return `repos/${m.repo}/${t.kind === "issueComment" ? "issues" : "pulls"}/comments/${String(t.id)}/reactions`;
}

const Reaction = z.object({ id: z.number(), login: z.string().nullable() });

/** Isaac's reaction of that emoji's id, null when he has none. Throws when it can't tell. */
async function myReaction(d: GithubWritesDeps, m: Of<"react">): Promise<number | null> {
  const login = d.login();
  if (login === null) throw new Error("The host has no GitHub account resolved");
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
async function myCommentsSince(d: GithubWritesDeps, m: Of<"comment" | "reviewComment" | "reviewReply">, startedAt: number): Promise<ListedComment[] | null> {
  const login = d.login();
  if (login === null) return null;
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
  if (mine === null) return "unknown";
  return mine.some((c) => sameComment(m, c)) ? "done" : "notDone";
}

// ---- The executor ----

const opened = (pr: PrLive, revision: string, summary: string): CheckResult => (pr.state === "OPEN" ? { ok: true, revision, summary } : invalid("This PR is closed"));
const exists = (revision: string, summary: string): CheckResult => ({ ok: true, revision, summary });

type Checks = { [K in Kind]: (d: GithubWritesDeps, pr: PrLive, m: Of<K>) => CheckResult | Promise<CheckResult> };
type Runs = { [K in Kind]: (d: GithubWritesDeps, m: Of<K>) => Promise<OpResult> };
type Reconciles = { [K in Kind]: (d: GithubWritesDeps, m: Of<K>, startedAt: number) => Promise<Reconciled> };

const CHECKS: Checks = {
  merge: (_d, pr, m) => checkMerge(pr, m),
  autoMerge: (_d, pr, m) => checkAutoMerge(pr, m),
  rerun: checkRerun,
  requestReview: (_d, pr, m) => opened(pr, pr.headSha, `Ask ${m.logins.join(", ")} to review ${prKey(m)}`),
  react: (_d, _pr, m) => exists("-", `${m.on ? "React" : "Remove reaction"} :${m.emoji}: on ${prKey(m)}`),
  comment: (_d, _pr, m) => exists("-", `Comment on ${prKey(m)}:\n${m.body}`),
  reviewComment: (_d, _pr, m) => exists("-", `Comment on ${m.path}:${String(m.line)} in ${prKey(m)}:\n${m.body}`),
  reviewReply: (_d, _pr, m) => exists("-", `Reply in ${prKey(m)}:\n${m.body}`),
};

const RUNS: Runs = {
  merge: runMerge,
  autoMerge: runAutoMerge,
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
  autoMerge: reconcileMerge,
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

/** github-sync's hook: a new head on a PR Relay armed auto-merge for turns it off through the executor and flags it. */
export function relayAutoMergeWatch(exec: MutationExecutor<PrMutation>, store: RelayAutoMerge, log: (line: string) => void): AutoMergeWatch {
  return {
    disarmed: (ref) => store.isDisarmed(prKey(ref)),
    async headSeen(ref, head, open) {
      const key = prKey(ref);
      const armedAt = store.armedHead(key);
      if (armedAt === undefined || armedAt === head) return;
      if (!open) {
        store.forget(key);
        return;
      }
      try {
        await exec.run({ kind: "autoMerge", repo: ref.repo, number: ref.number, on: false, expectHead: head }, randomUUID());
        store.disarm(key, head);
        log(`tickets: ${key} got new commits (${short(head)}): Relay's auto-merge turned off`);
      } catch (error) {
        log(`tickets: ${key} auto-merge could not be turned off: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
