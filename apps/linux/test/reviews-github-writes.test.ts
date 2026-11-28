import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrMutation } from "@relay/protocol";
import type { ToolResult, ToolRun } from "../src/reviews/exec";
import { GitHub, ghGraphql } from "../src/reviews/github";
import { githubExecutor, StaleGithubCredential } from "../src/reviews/github-writes";
import { PrGate, type GithubPin } from "../src/reviews/pr-gate";
import { ReviewsService, DRY_RUN_ERROR, type PrWritesGate } from "../src/reviews/service";
import { systemClock } from "../src/session";

const REPO = "eCardSystems/api";
const N = 42;
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const ME = "webdevike";
const DEVICE = "device-1";
const T0 = Date.parse("2026-11-27T12:00:00Z");
let seq = 0;
const opId = (): string => `6d796135-613d-4bd8-ae3f-${String(++seq).padStart(12, "0")}`;

interface FakePr {
  state: string;
  isDraft: boolean;
  head: string;
  mergeStateStatus: string;
  mergeable: string;
  queue: boolean;
  inQueue: boolean;
  permission: string;
  methods: { merge: boolean; squash: boolean; rebase: boolean };
  requested: string[];
  base: string;
  title: string;
}

interface Listed {
  id: number;
  login: string;
  body: string;
  created_at: string;
  url: string;
  path: string | null;
  reply: number | null;
}

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const no = (stderr: string): ToolResult => ({ code: 1, stdout: "", stderr, timedOut: false });

/** gh over one PR: GraphQL reads, REST reads and the writes, every argv recorded. */
class FakeGh {
  pr: FakePr = {
    state: "OPEN",
    isDraft: false,
    head: H1,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    queue: false,
    inQueue: false,
    permission: "WRITE",
    methods: { merge: true, squash: true, rebase: false },
    requested: [],
    base: "main",
    title: "Ship the board",
  };
  readonly runs = new Map<number, { head_sha: string; conclusion: string | null; run_attempt: number }>();
  /** The Actions runs of the head's failed checks. */
  failedRuns: number[] = [7];
  readonly reactions = new Map<string, { id: number; login: string; content: string }[]>();
  readonly issueComments: Listed[] = [];
  readonly reviewComments: Listed[] = [];
  readonly calls: string[][] = [];
  /** The next write reaches GitHub but its answer is lost. */
  loseNext = false;
  /** The next write never reaches GitHub and its answer is lost too. */
  dropNext = false;
  /** Sees every call before gh answers it (a test moves the account mid-op). */
  onCall: (args: readonly string[]) => void = () => undefined;
  /** Review/conversation comment ids that belong to another PR. */
  readonly foreign = new Set<number>();
  private nextId = 100;

  readonly run: ToolRun = (argv) => {
    const args = argv.slice(1);
    this.calls.push(args);
    this.onCall(args);
    if (args[1] === "graphql") return Promise.resolve(this.graphql());
    return Promise.resolve(this.rest(args));
  };

  /** Writes only (no reads). */
  writes(): string[][] {
    return this.calls.filter((a) => a[0] === "pr" || a[0] === "run" || (a[0] === "api" && a[1] !== "graphql" && (a.includes("POST") || a.includes("DELETE") || a.includes("-F") || a.some((x) => x.endsWith("/replies")))));
  }

  private graphql(): ToolResult {
    const p = this.pr;
    const repository = {
      viewerPermission: p.permission,
      mergeCommitAllowed: p.methods.merge,
      squashMergeAllowed: p.methods.squash,
      rebaseMergeAllowed: p.methods.rebase,
      pullRequest: {
        title: p.title,
        state: p.state,
        isDraft: p.isDraft,
        headRefOid: p.head,
        baseRefName: p.base,
        mergeable: p.mergeable,
        mergeStateStatus: p.mergeStateStatus,
        isInMergeQueue: p.inQueue,
        isMergeQueueEnabled: p.queue,
        mergeQueueEntry: p.inQueue ? { state: "QUEUED" } : null,
        latestReviews: { nodes: [{ author: { login: "todd" }, state: "APPROVED", submittedAt: "2026-11-27T10:00:00Z" }] },
        reviewRequests: { nodes: p.requested.map((login) => ({ requestedReviewer: { login } })) },
        commits: {
          nodes: [
            {
              commit: {
                oid: p.head,
                statusCheckRollup: {
                  contexts: {
                    nodes: this.failedRuns.map((id) => ({ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://x", checkSuite: { workflowRun: { databaseId: id, runNumber: 3, workflow: { name: "CI" } } } })),
                  },
                },
              },
            },
          ],
        },
      },
    };
    return ok(`HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 4990\r\n\r\n${JSON.stringify({ data: { viewer: { login: ME }, repository } })}`);
  }

  private rest(a: string[]): ToolResult {
    const writing = a[0] === "pr" || a[0] === "run" || a.includes("POST") || a.includes("DELETE") || a.includes("-F") || a.some((x) => x.endsWith("/replies"));
    if (writing && this.dropNext) {
      this.dropNext = false;
      return no("read tcp: connection reset by peer");
    }
    if (a[0] === "pr" || a[0] === "run") return this.ghWrite(a);
    const path = a.find((x) => x.startsWith("repos/")) ?? "";
    const run = /actions\/runs\/(\d+)$/.exec(path);
    if (run !== null) {
      const facts = this.runs.get(Number(run[1]));
      if (facts === undefined) return no("gh: Not Found (HTTP 404)");
      return ok(a.includes("--jq") ? String(facts.run_attempt) : JSON.stringify(facts));
    }
    const one = /(issues|pulls)\/comments\/(\d+)$/.exec(path);
    if (one !== null && !writing) return this.comment(one[1] ?? "", Number(one[2]));
    if (path.endsWith("/reactions") || /\/reactions\/\d+$/.test(path)) return this.react(a, path);
    if (a.includes("GET")) return ok(this.listed(path).map((c) => JSON.stringify(c)).join("\n"));
    return this.post(a, path);
  }

  /** One comment as `commentOn` reads it: on this PR unless `foreign`. */
  private comment(where: string, id: number): ToolResult {
    const number = this.foreign.has(id) ? 7 : N;
    const url = `https://api.github.com/repos/${REPO}/${where}/${String(number)}`;
    return ok(JSON.stringify({ pr: where === "pulls" ? url : null, issue: where === "issues" ? url : null, reply: id === 556 ? 555 : null, author: "todd", path: where === "pulls" ? "src/a.ts" : null }));
  }

  private listed(path: string): Listed[] {
    return path.includes("/issues/") ? this.issueComments : this.reviewComments;
  }

  private lost(result: ToolResult): ToolResult {
    if (!this.loseNext) return result;
    this.loseNext = false;
    return no("read tcp: connection reset by peer");
  }

  private ghWrite(a: string[]): ToolResult {
    if (a[0] === "run") {
      const facts = this.runs.get(Number(a[2]));
      if (facts !== undefined) Object.assign(facts, { run_attempt: facts.run_attempt + 1, conclusion: null });
      return this.lost(ok());
    }
    if (a[1] === "edit") {
      this.pr.requested.push(...(a[a.indexOf("--add-reviewer") + 1] ?? "").split(","));
      return this.lost(ok());
    }
    if (a[1] === "comment") {
      const body = a[a.indexOf("--body") + 1] ?? "";
      const id = this.nextId++;
      this.issueComments.push({ id, login: "webdevike", body, created_at: new Date(T0).toISOString(), url: `https://github.com/${REPO}/pull/${String(N)}#issuecomment-${String(id)}`, path: null, reply: null });
      return this.lost(ok(`https://github.com/${REPO}/pull/${String(N)}#issuecomment-${String(id)}\n`));
    }
    return this.lost(this.merge(a));
  }

  private merge(a: string[]): ToolResult {
    if (a[a.indexOf("--match-head-commit") + 1] !== this.pr.head) return no("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)");
    this.pr.state = "MERGED";
    return ok();
  }

  private react(a: string[], path: string): ToolResult {
    const del = /^(.*)\/(\d+)$/.exec(path);
    if (a.includes("DELETE") && del !== null) {
      const list = this.reactions.get(del[1] ?? "") ?? [];
      this.reactions.set(del[1] ?? "", list.filter((r) => r.id !== Number(del[2])));
      return ok();
    }
    const content = (a.find((x) => x.startsWith("content=")) ?? "").slice(8);
    const list = this.reactions.get(path) ?? [];
    if (a.includes("POST")) {
      list.push({ id: this.nextId++, login: "webdevike", content });
      this.reactions.set(path, list);
      return ok("{}");
    }
    return ok(list.filter((r) => r.content === content).map((r) => JSON.stringify({ id: r.id, login: r.login })).join("\n"));
  }

  private post(a: string[], path: string): ToolResult {
    const field = (k: string): string => (a.find((x) => x.startsWith(`${k}=`)) ?? "").slice(k.length + 1);
    const id = this.nextId++;
    const reply = /comments\/(\d+)\/replies$/.exec(path);
    this.reviewComments.push({ id, login: "webdevike", body: field("body"), created_at: new Date(T0).toISOString(), url: `https://github.com/r/${String(id)}`, path: reply === null ? field("path") : null, reply: reply === null ? null : Number(reply[1]) });
    return this.lost(ok(JSON.stringify({ id, html_url: `https://github.com/r/${String(id)}` })));
  }
}

/** The host's account as the PR gate pins it: `generation` moves on an account change, `credential` on a gh token change. */
interface Account {
  login: string | null;
  generation: number;
  credential: string;
}

function setup(o: { writes?: boolean; dir?: string; gh?: FakeGh } = {}) {
  const gh = o.gh ?? new FakeGh();
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "relay-gh-writes-"));
  const account: Account = { login: ME, generation: 1, credential: "token-1" };
  const executor = (guard: () => Promise<void>) => githubExecutor({ run: gh.run, gh: "gh", graphql: ghGraphql(gh.run, "gh", null), budget: null, login: () => ME, guard });
  /** The executor alone, its writes never stopped by a pin. */
  const exec = executor(() => Promise.resolve());
  /** Asked right before each write; a test can move the account while a check runs. */
  let beforeWrite = (): void => undefined;
  const current = (p: GithubPin): Promise<boolean> => {
    beforeWrite();
    return Promise.resolve(p.login === account.login && p.generation === account.generation && p.credential === account.credential);
  };
  /** As the tickets service pins it: the executor's guard asks `current` for this pin before every gh write. */
  const pin = (): Promise<GithubPin | null> => {
    if (account.login === null) return Promise.resolve(null);
    const guard = async (): Promise<void> => {
      if (!(await current(p))) throw new StaleGithubCredential();
    };
    const p: GithubPin = { login: account.login, generation: account.generation, credential: account.credential, github: executor(guard) };
    return Promise.resolve(p);
  };
  const gate = new PrGate({ dir, writesEnabled: () => o.writes ?? true, pin, current, now: () => T0, log: () => undefined });
  /** prepare (when confirmed) then commit. */
  const write = async (m: PrMutation, id = opId()) => {
    const prepared = await gate.prepare(DEVICE, m, ME);
    const approvalId = prepared.approval?.id;
    return gate.commit(DEVICE, { opId: id, mutation: m, ...(approvalId === undefined ? {} : { approvalId }) }, ME);
  };
  return { gh, dir, exec, executor, gate, write, account, onWrite: (f: () => void) => (beforeWrite = f) };
}

const merge = (over: Partial<Extract<PrMutation, { kind: "merge" }>> = {}): PrMutation => ({ kind: "merge", repo: REPO, number: N, method: "squash", expectHead: H1, expectBase: "main", ...over });
const STALE = "The host's GitHub sign-in or account changed while writing. Reload and try again.";

describe("GitHub PR writes: argv per op", () => {
  it("merges with the method and the head it saw, never --admin", async () => {
    const { gh, write } = setup();
    const answer = await write(merge());
    expect(answer).toMatchObject({ ok: true, outcome: { state: "done", result: { merge: "merged" } } });
    expect(gh.writes()).toEqual([["pr", "merge", "42", "--repo", REPO, "--squash", "--match-head-commit", H1]]);
  });

  it("re-runs a failed run of the head at its attempt", async () => {
    const { gh, write } = setup();
    gh.runs.set(7, { head_sha: H1, conclusion: "failure", run_attempt: 1 });
    expect(await write({ kind: "rerun", repo: REPO, number: N, runId: 7, attempt: 1, headSha: H1 })).toMatchObject({ ok: true, outcome: { state: "done" } });
    expect(gh.writes()).toEqual([["run", "rerun", "7", "--failed", "--repo", REPO]]);
    expect(gh.calls).toContainEqual(["api", `repos/${REPO}/actions/runs/7`]);
  });

  it("requests reviews, comments, review comments and replies with the exact text, confirmed in full", async () => {
    const { gh, gate, write } = setup();
    await write({ kind: "requestReview", repo: REPO, number: N, logins: ["todd", "eCardSystems/core"] });
    const comment: PrMutation = { kind: "comment", repo: REPO, number: N, body: "Ship it\n\nSecond paragraph" };
    expect((await gate.prepare(DEVICE, comment, ME)).approval).toMatchObject({ summary: `Comment on ${REPO}#42 (Ship the board) as ${ME}`, text: "Ship it\n\nSecond paragraph" });
    const commented = await write(comment);
    expect(commented.outcome?.result?.url).toContain("#issuecomment-");
    const line = await write({ kind: "reviewComment", repo: REPO, number: N, commitId: H1, path: "src/a.ts", line: 12, side: "RIGHT", body: "Why?" });
    expect(line.outcome?.result).toMatchObject({ id: expect.any(String), url: expect.stringContaining("https://github.com/r/") });
    const reply: PrMutation = { kind: "reviewReply", repo: REPO, number: N, commentId: 555, body: "Because" };
    expect((await gate.prepare(DEVICE, reply, ME)).approval).toMatchObject({ summary: `Reply to todd's thread on src/a.ts in ${REPO}#42 (Ship the board) as ${ME}`, text: "Because" });
    await write(reply);
    expect(gh.writes()).toEqual([
      ["pr", "edit", "42", "--repo", REPO, "--add-reviewer", "todd,eCardSystems/core"],
      ["pr", "comment", "42", "--repo", REPO, "--body", "Ship it\n\nSecond paragraph"],
      ["api", `repos/${REPO}/pulls/42/comments`, "-f", "body=Why?", "-f", `commit_id=${H1}`, "-f", "path=src/a.ts", "-F", "line=12", "-f", "side=RIGHT"],
      ["api", `repos/${REPO}/pulls/42/comments/555/replies`, "-f", "body=Because"],
    ]);
  });

  it("sets reactions on the right endpoint as a desired state", async () => {
    const { gh, write } = setup();
    const react = (target: Extract<PrMutation, { kind: "react" }>["target"], on = true): PrMutation => ({ kind: "react", repo: REPO, number: N, target, emoji: "+1", on });
    await write(react({ kind: "prBody" }), opId());
    await write(react({ kind: "prBody" }), opId());
    await write(react({ kind: "issueComment", id: 11 }), opId());
    await write(react({ kind: "reviewComment", id: 12 }), opId());
    await write(react({ kind: "prBody" }, false), opId());
    await write(react({ kind: "prBody" }, false), opId());
    const writes = gh.writes();
    expect(writes).toEqual([
      ["api", "-X", "POST", `repos/${REPO}/issues/42/reactions`, "-f", "content=+1"],
      ["api", "-X", "POST", `repos/${REPO}/issues/comments/11/reactions`, "-f", "content=+1"],
      ["api", "-X", "POST", `repos/${REPO}/pulls/comments/12/reactions`, "-f", "content=+1"],
      ["api", "-X", "DELETE", `repos/${REPO}/issues/42/reactions/100`],
    ]);
  });
});

describe("GitHub PR writes: refusals", () => {
  it("refuses conflict when the head moved while Isaac confirmed, writing nothing", async () => {
    const { gh, gate } = setup();
    const prepared = await gate.prepare(DEVICE, merge(), ME);
    expect(prepared.approval?.summary).toBe(`Merge now: ${REPO}#42 (Ship the board) at aaaaaaa into main (squash)`);
    gh.pr.head = H2;
    const answer = await gate.commit(DEVICE, { opId: opId(), mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME);
    expect(answer.refused?.code).toBe("conflict");
    expect(answer.refused?.message).toContain("New commits since you looked");
    expect(gh.writes()).toEqual([]);
  });

  it("refuses conflict when the base changed since Isaac confirmed, before or after prepare, writing nothing", async () => {
    const { gh, gate } = setup();
    const prepared = await gate.prepare(DEVICE, merge(), ME);
    gh.pr.base = "release";
    const answer = await gate.commit(DEVICE, { opId: opId(), mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME);
    expect(answer.refused).toMatchObject({ code: "conflict", message: "It now merges into release, not main. Check it and confirm again." });
    expect((await gate.prepare(DEVICE, merge(), ME)).refused?.code).toBe("conflict");
    expect(gh.writes()).toEqual([]);
  });

  it("refuses when GitHub would no longer merge it at once by the commit (blocked or a merge queue now), writing nothing", async () => {
    const { gh, gate } = setup();
    for (const change of [{ mergeStateStatus: "BLOCKED" }, { queue: true }] satisfies Partial<FakePr>[]) {
      Object.assign(gh.pr, { mergeStateStatus: "CLEAN", queue: false });
      const prepared = await gate.prepare(DEVICE, merge(), ME);
      expect(prepared.approval?.summary).toContain("Merge now");
      Object.assign(gh.pr, change);
      const answer = await gate.commit(DEVICE, { opId: opId(), mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME);
      expect(answer.refused?.code).toBe("invalid");
    }
    expect(gh.writes()).toEqual([]);
  });

  it("refuses a reply or reaction to a comment on another PR, and a reply to a reply", async () => {
    const { gh, write } = setup();
    gh.foreign.add(900);
    expect((await write({ kind: "reviewReply", repo: REPO, number: N, commentId: 900, body: "x" })).refused?.code).toBe("invalid");
    expect((await write({ kind: "react", repo: REPO, number: N, target: { kind: "issueComment", id: 900 }, emoji: "+1", on: true })).refused?.code).toBe("invalid");
    expect((await write({ kind: "reviewReply", repo: REPO, number: N, commentId: 556, body: "x" })).refused?.message).toBe("Reply to the first comment of the thread");
    expect(gh.writes()).toEqual([]);
  });

  it("refuses a line comment on another head than GitHub's", async () => {
    const { gh, write } = setup();
    gh.pr.head = H2;
    expect((await write({ kind: "reviewComment", repo: REPO, number: N, commitId: H1, path: "src/a.ts", line: 1, side: "RIGHT", body: "x" })).refused?.code).toBe("conflict");
    expect(gh.writes()).toEqual([]);
  });

  it("never offers auto-merge or a merge queue: a PR that can't merge now is refused with its reason", async () => {
    const { gh, gate } = setup();
    gh.pr.mergeStateStatus = "BLOCKED";
    expect((await gate.prepare(DEVICE, merge(), ME)).refused).toEqual({ code: "invalid", message: "Required reviews or checks haven't passed yet" });
    gh.pr.queue = true;
    gh.pr.mergeStateStatus = "CLEAN";
    expect((await gate.prepare(DEVICE, merge(), ME)).refused).toEqual({ code: "invalid", message: "This branch merges through a merge queue. Add it to the queue on GitHub." });
    expect(gh.calls.some((a) => a.includes("--auto") || a.includes("--disable-auto"))).toBe(false);
    expect(gh.writes()).toEqual([]);
  });

  it.each([
    ["blocked", { mergeStateStatus: "BLOCKED" }, "invalid", "Required reviews or checks"],
    ["draft", { isDraft: true }, "invalid", "draft"],
    ["no permission", { permission: "READ" }, "invalid", "can't merge"],
    ["no method", { methods: { merge: true, squash: false, rebase: false } }, "invalid", "squash merges are off"],
    ["conflicts", { mergeable: "CONFLICTING" }, "invalid", "conflicts"],
    ["already merged", { state: "MERGED" }, "conflict", "already merged"],
    ["behind", { mergeStateStatus: "BEHIND" }, "invalid", "behind its base"],
    ["a merge queue", { queue: true }, "invalid", "merges through a merge queue"],
    ["already in the queue", { inQueue: true }, "conflict", "already in the merge queue"],
  ] satisfies [string, Partial<FakePr>, string, string][])("refuses a merge when %s", async (_name, change, code, message) => {
    const { gh, write } = setup();
    Object.assign(gh.pr, change);
    const answer = await write(merge());
    expect(answer.refused?.code).toBe(code);
    expect(answer.refused?.message).toContain(message);
    expect(gh.writes()).toEqual([]);
  });

  it("refuses a re-run of an unrelated, succeeded or already re-run run", async () => {
    const { gh, write } = setup();
    const rerun = (runId: number, attempt = 1): PrMutation => ({ kind: "rerun", repo: REPO, number: N, runId, attempt, headSha: H1 });
    gh.runs.set(1, { head_sha: H2, conclusion: "failure", run_attempt: 1 });
    gh.runs.set(2, { head_sha: H1, conclusion: "success", run_attempt: 1 });
    gh.runs.set(3, { head_sha: H1, conclusion: "failure", run_attempt: 2 });
    expect((await write(rerun(1))).refused?.message).toBe("That run isn't for this PR's head commit");
    expect((await write(rerun(2))).refused?.message).toBe("That run didn't fail");
    expect((await write(rerun(3, 1))).refused).toMatchObject({ code: "conflict", message: "That run was already re-run" });
    expect(gh.writes()).toEqual([]);
  });

  it("refuses every kind when writes are off (dry run), before reading GitHub", async () => {
    const { gh, write } = setup({ writes: false });
    const kinds: PrMutation[] = [
      merge(),
      { kind: "rerun", repo: REPO, number: N, runId: 7, attempt: 1, headSha: H1 },
      { kind: "requestReview", repo: REPO, number: N, logins: ["todd"] },
      { kind: "react", repo: REPO, number: N, target: { kind: "prBody" }, emoji: "heart", on: true },
      { kind: "comment", repo: REPO, number: N, body: "x" },
      { kind: "reviewComment", repo: REPO, number: N, commitId: H1, path: "a", line: 1, side: "LEFT", body: "x" },
      { kind: "reviewReply", repo: REPO, number: N, commentId: 1, body: "x" },
    ];
    for (const m of kinds) expect((await write(m)).refused?.code).toBe("writesOff");
    expect(gh.calls).toEqual([]);
  });

  it("refuses a device that saw another gh login, and a host with no verified gh account, with zero gh calls", async () => {
    const { gh, gate, account } = setup();
    expect((await gate.commit(DEVICE, { opId: opId(), mutation: merge() }, "someone-else")).refused?.code).toBe("identity");
    expect((await gate.prepare(DEVICE, merge(), "someone-else")).refused?.code).toBe("identity");
    account.login = null;
    expect((await gate.prepare(DEVICE, merge(), ME)).refused?.message).toBe("The host hasn't confirmed its GitHub account yet. Try again in a moment.");
    expect(gh.calls).toEqual([]);
  });

  it("voids an approval when the host's account changes, and stops a write when gh's credential changes during the check", async () => {
    const { gh, gate, account, onWrite } = setup();
    const prepared = await gate.prepare(DEVICE, merge(), ME);
    account.generation += 1;
    expect((await gate.commit(DEVICE, { opId: opId(), mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME)).refused?.code).toBe("approval");
    const again = await gate.prepare(DEVICE, merge(), ME);
    onWrite(() => (account.credential = "token-2"));
    const stale = await gate.commit(DEVICE, { opId: opId(), mutation: merge(), approvalId: again.approval?.id ?? "" }, ME);
    expect(stale.refused).toMatchObject({ code: "identity", message: "The host's GitHub sign-in or account changed while checking. Reload and try again." });
    expect(gh.writes()).toEqual([]);
  });

  it("answers a GitHub refusal in the host's words, never gh's stderr", async () => {
    const { gh, exec, write } = setup();
    gh.pr.head = H2;
    await expect(exec.run(merge(), opId())).rejects.toMatchObject({ name: "ProviderRejected", publicMessage: "GitHub refused the merge; nothing was merged. Check the PR on GitHub." });
    const answer = await write({ kind: "comment", repo: REPO, number: N, body: "x" });
    expect(answer.ok).toBe(true);
    gh.dropNext = true;
    const lost = await write({ kind: "comment", repo: REPO, number: N, body: "y" });
    expect(lost.outcome).toMatchObject({ state: "unknown", result: { error: "Couldn't reach GitHub. Try again in a moment." } });
    expect(JSON.stringify(lost)).not.toContain("tcp");
  });
});

describe("GitHub PR writes: the pinned credential before every write", () => {
  const kinds: PrMutation[] = [
    merge(),
    { kind: "rerun", repo: REPO, number: N, runId: 7, attempt: 1, headSha: H1 },
    { kind: "requestReview", repo: REPO, number: N, logins: ["todd"] },
    { kind: "react", repo: REPO, number: N, target: { kind: "prBody" }, emoji: "heart", on: true },
    { kind: "react", repo: REPO, number: N, target: { kind: "issueComment", id: 11 }, emoji: "heart", on: false },
    { kind: "comment", repo: REPO, number: N, body: "x" },
    { kind: "reviewComment", repo: REPO, number: N, commitId: H1, path: "a", line: 1, side: "LEFT", body: "x" },
    { kind: "reviewReply", repo: REPO, number: N, commentId: 555, body: "x" },
  ];

  it("asks the guard immediately before each kind's gh write, and sends nothing when it refuses", async () => {
    const { gh, executor } = setup();
    gh.runs.set(7, { head_sha: H1, conclusion: "failure", run_attempt: 1 });
    gh.reactions.set(`repos/${REPO}/issues/comments/11/reactions`, [{ id: 5, login: ME, content: "heart" }]);
    const order: string[] = [];
    gh.onCall = (a) => order.push(a.join(" "));
    const stale = executor(() => {
      order.push("guard");
      return Promise.reject(new StaleGithubCredential());
    });
    for (const m of kinds) await expect(stale.run(m, opId())).rejects.toMatchObject({ name: "ProviderRejected", publicMessage: STALE });
    expect(gh.writes()).toEqual([]);
    expect(order.filter((o) => o === "guard")).toHaveLength(kinds.length);
    // The reactions' own reads come first; the guard is the last thing before the write.
    expect(order.at(-1)).toBe("guard");
    expect(order.filter((o) => o.includes("reactions"))).toHaveLength(2);
  });

  it("stops a reaction when gh's credential changes during the executor's own read, with zero writes", async () => {
    const { gh, write, account } = setup();
    gh.onCall = (a) => {
      if (a.includes("GET") && a.some((x) => x.endsWith("/reactions"))) account.credential = "token-2";
    };
    const answer = await write({ kind: "react", repo: REPO, number: N, target: { kind: "prBody" }, emoji: "+1", on: true });
    expect(answer).toMatchObject({ ok: false, error: STALE, outcome: { state: "failed" } });
    expect(gh.writes()).toEqual([]);
  });

  it("stops a write when the account changes during the check's read, with zero writes", async () => {
    const { gh, write, account } = setup();
    gh.onCall = (a) => {
      if (a.some((x) => x.endsWith("/pulls/comments/555"))) account.generation += 1;
    };
    const answer = await write({ kind: "reviewReply", repo: REPO, number: N, commentId: 555, body: "x" });
    expect(answer.ok).toBe(false);
    expect(gh.writes()).toEqual([]);
  });

  it("refuses a retarget or a push between the confirm and the write, with zero writes", async () => {
    const { gh, gate } = setup();
    for (const change of [{ base: "release" }, { head: H2 }] satisfies Partial<FakePr>[]) {
      Object.assign(gh.pr, { base: "main", head: H1 });
      const prepared = await gate.prepare(DEVICE, merge(), ME);
      Object.assign(gh.pr, change);
      expect((await gate.commit(DEVICE, { opId: opId(), mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME)).refused?.code).toBe("conflict");
    }
    expect(gh.writes()).toEqual([]);
  });
});

describe("GitHub PR writes: outcomes and desired state", () => {
  it("answers a repeated opId from the store with one merge", async () => {
    const { gh, write } = setup();
    const id = opId();
    const first = await write(merge(), id);
    const again = await write(merge(), id);
    expect(again).toEqual(first);
    expect(gh.writes()).toHaveLength(1);
  });

  it("reconciles a lost comment by finding it, and never posts it twice", async () => {
    const { gh, gate } = setup();
    const m: PrMutation = { kind: "comment", repo: REPO, number: N, body: "Looks good" };
    const prepared = await gate.prepare(DEVICE, m, ME);
    const id = opId();
    gh.loseNext = true;
    const lost = await gate.commit(DEVICE, { opId: id, mutation: m, approvalId: prepared.approval?.id ?? "" }, ME);
    expect(lost.outcome?.state).toBe("unknown");
    const retry = await gate.commit(DEVICE, { opId: id, mutation: m }, ME);
    expect(retry.outcome?.state).toBe("done");
    expect(gh.writes().filter((a) => a[1] === "comment")).toHaveLength(1);
  });

  it("never sends a lost write again on retry, after a restart, or for another account or device", async () => {
    const first = setup();
    const m: PrMutation = { kind: "comment", repo: REPO, number: N, body: "Only once" };
    const prepared = await first.gate.prepare(DEVICE, m, ME);
    const id = opId();
    first.gh.dropNext = true;
    expect((await first.gate.commit(DEVICE, { opId: id, mutation: m, approvalId: prepared.approval?.id ?? "" }, ME)).outcome?.state).toBe("unknown");
    // GitHub doesn't show it: still unknown, and nothing is posted again.
    expect((await first.gate.commit(DEVICE, { opId: id, mutation: m }, ME)).outcome?.state).toBe("unknown");
    const restarted = setup({ dir: first.dir, gh: first.gh });
    expect((await restarted.gate.commit(DEVICE, { opId: id, mutation: m }, ME)).outcome?.state).toBe("unknown");
    expect((await restarted.gate.commit("device-2", { opId: id, mutation: m }, ME)).refused?.code).toBe("identity");
    restarted.account.credential = "token-2";
    expect((await restarted.gate.commit(DEVICE, { opId: id, mutation: m }, ME)).refused).toMatchObject({ code: "identity", message: expect.stringContaining("sign-in changed") });
    restarted.account.credential = "token-1";
    restarted.account.login = "someone-else";
    expect((await restarted.gate.commit(DEVICE, { opId: id, mutation: m }, "someone-else")).refused?.code).toBe("identity");
    // Every attempt above hit GitHub once: the first, dropped one.
    expect(first.gh.writes().filter((a) => a[1] === "comment")).toHaveLength(1);
  });

  it("never merges twice: a lost merge GitHub doesn't show stays unknown across retries and a restart", async () => {
    const first = setup();
    const prepared = await first.gate.prepare(DEVICE, merge(), ME);
    const id = opId();
    first.gh.dropNext = true;
    expect((await first.gate.commit(DEVICE, { opId: id, mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME)).outcome?.state).toBe("unknown");
    expect((await first.gate.commit(DEVICE, { opId: id, mutation: merge() }, ME)).outcome?.state).toBe("unknown");
    const restarted = setup({ dir: first.dir, gh: first.gh });
    expect((await restarted.gate.commit(DEVICE, { opId: id, mutation: merge() }, ME)).outcome?.state).toBe("unknown");
    expect(first.gh.writes()).toHaveLength(1);
  });

  it("reconciles a lost merge from GitHub's state", async () => {
    const { gh, gate } = setup();
    const prepared = await gate.prepare(DEVICE, merge(), ME);
    const id = opId();
    gh.loseNext = true;
    expect((await gate.commit(DEVICE, { opId: id, mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME)).outcome?.state).toBe("unknown");
    expect((await gate.commit(DEVICE, { opId: id, mutation: merge() }, ME)).outcome?.state).toBe("done");
    expect(gh.writes()).toHaveLength(1);
  });

  it("keeps a GitHub refusal as failed (nothing written)", async () => {
    const { gh, exec } = setup();
    gh.pr.head = H2;
    await expect(exec.run(merge(), opId())).rejects.toMatchObject({ name: "ProviderRejected" });
  });
});

describe("PR read actions facts", () => {
  const raw = { number: N, title: "t", url: "u", state: "OPEN", isDraft: false, author: null, createdAt: "", updatedAt: "", body: "", baseRefName: "main", baseRefOid: "c".repeat(40), headRefName: "f", headRefOid: H1, additions: 0, deletions: 0, commits: [], files: [], reviewRequests: [], latestReviews: [], reviews: [], comments: [], assignees: [], labels: [], statusCheckRollup: [] };
  const compare = (argv: readonly string[]): boolean => argv.some((a) => a.includes("/compare/"));

  /** gh for a PR read: the view and compare answered here, everything else by `gh`; `calls` records each argv. */
  function prRun(gh: FakeGh, calls: string[][] = []): ToolRun {
    return (argv, options) => {
      calls.push(argv.slice(1));
      if (argv[1] === "pr" && argv[2] === "view") return Promise.resolve(ok(JSON.stringify(raw)));
      if (compare(argv)) return Promise.resolve(ok(""));
      return gh.run(argv, options);
    };
  }
  const ON = (): boolean => true;

  it("adds merge, queue, review and check facts, with each failed run's attempt", async () => {
    const gh = new FakeGh();
    gh.runs.set(7, { head_sha: H1, conclusion: "failure", run_attempt: 2 });
    const pr = await new GitHub(prRun(gh), "gh", undefined, null, ON).pr(REPO, N);
    expect(pr.actions).toEqual({
      viewerLogin: ME,
      viewerPermission: "WRITE",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      methods: { merge: true, squash: true, rebase: false },
      mergeQueue: { required: false, inQueue: false, entryState: null },
      reviews: [{ login: "todd", state: "APPROVED", at: Date.parse("2026-11-27T10:00:00Z") }],
      checks: [{ name: "test", state: "fail", url: "https://x", workflow: "CI", runId: 7, runNumber: 3, attempt: 2, headSha: H1 }],
    });
    expect(gh.calls).toContainEqual(["api", `repos/${REPO}/actions/runs/7`, "--jq", ".run_attempt"]);
  });

  it("leaves actions out when GitHub can't say, or already has another head than the page's", async () => {
    const run: ToolRun = (argv) => Promise.resolve(argv[2] === "view" ? ok(JSON.stringify(raw)) : compare(argv) ? ok("") : no("boom"));
    expect((await new GitHub(run, "gh", undefined, null, ON).pr(REPO, N)).actions).toBeUndefined();
    const gh = new FakeGh();
    gh.pr.head = H2;
    expect((await new GitHub(prRun(gh), "gh", undefined, null, ON).pr(REPO, N)).actions).toBeUndefined();
  });

  it("with PR actions off makes exactly the view and diff reads, and adds the action, reaction and review-line reads only when on", async () => {
    const gh = new FakeGh();
    gh.runs.set(7, { head_sha: H1, conclusion: "failure", run_attempt: 2 });
    const off: string[][] = [];
    const read = await new GitHub(prRun(gh, off), "gh").pr(REPO, N);
    expect(off.map((a) => a.slice(0, 2))).toEqual([
      ["pr", "view"],
      ["api", `repos/${REPO}/compare/${"c".repeat(40)}...${H1}`],
    ]);
    expect([read.actions, read.reviewComments, read.bodyReactions]).toEqual([undefined, undefined, undefined]);
    const on: string[][] = [];
    await new GitHub(prRun(gh, on), "gh", undefined, null, ON).pr(REPO, N);
    // + the actions facts, review comments and reactions (GraphQL), and the failed run's attempt.
    expect(on.filter((a) => a[1] === "graphql")).toHaveLength(3);
    expect(on.filter((a) => a.some((x) => x.includes("/actions/runs/")))).toHaveLength(1);
    expect(on).toHaveLength(6);
  });

  it("asks a bounded number of failed runs' attempts, two at a time", async () => {
    const gh = new FakeGh();
    gh.failedRuns = Array.from({ length: 12 }, (_, i) => i + 1);
    for (const id of gh.failedRuns) gh.runs.set(id, { head_sha: H1, conclusion: "failure", run_attempt: 1 });
    let open = 0;
    let most = 0;
    const base = prRun(gh);
    const run: ToolRun = async (argv, options) => {
      if (!argv.some((a) => a.includes("/actions/runs/"))) return base(argv, options);
      most = Math.max(most, ++open);
      await Promise.resolve();
      open -= 1;
      return base(argv, options);
    };
    const pr = await new GitHub(run, "gh", undefined, null, ON).pr(REPO, N);
    expect(gh.calls.filter((a) => a.some((x) => x.includes("/actions/runs/")))).toHaveLength(6);
    expect(most).toBe(2);
    expect(pr.actions?.checks.filter((c) => c.attempt !== null)).toHaveLength(6);
  });

  it("reads PR extras only while the host's PR gate is open (REVIEWS_ACTIONS_FEATURE)", async () => {
    const gh = new FakeGh();
    const service = (gate: PrWritesGate | null, calls: string[][]) =>
      new ReviewsService({
        dir: mkdtempSync(join(tmpdir(), "relay-reviews-pr-")),
        agentHome: null,
        writes: true,
        run: prRun(gh, calls),
        gh: "gh",
        claude: "claude",
        fetch: () => Promise.reject(new Error("no network in tests")),
        agents: { sessions: [], conversation: () => Promise.resolve(null), reply: () => Promise.resolve(), configure: () => Promise.resolve() },
        launch: null,
        sessionFile: () => null,
        socketPath: "/tmp/x.sock",
        tellAstra: () => Promise.resolve(),
        broadcast: () => undefined,
        clock: systemClock,
        log: () => undefined,
        prGate: () => gate,
      });
    const off: string[][] = [];
    await service(null, off).handle({ kind: "pr", repo: REPO, number: N }, "d");
    expect(off.map((a) => a.slice(0, 2))).toEqual([
      ["pr", "view"],
      ["api", `repos/${REPO}/compare/${"c".repeat(40)}...${H1}`],
    ]);
    const gate: PrWritesGate = { preparePr: () => Promise.resolve({ ok: true }), commitPr: () => Promise.resolve({ ok: true }) };
    const on: string[][] = [];
    await service(gate, on).handle({ kind: "pr", repo: REPO, number: N }, "d");
    expect(on.filter((a) => a[1] === "graphql")).toHaveLength(3);
  });
});

describe("Reviews prPrepare/prCommit", () => {
  function reviews(o: { writes?: boolean; gate?: PrWritesGate | null } = {}) {
    return new ReviewsService({
      dir: mkdtempSync(join(tmpdir(), "relay-reviews-pr-")),
      agentHome: null,
      writes: o.writes ?? true,
      run: () => Promise.resolve(no("no gh in tests")),
      gh: "gh",
      claude: "claude",
      fetch: () => Promise.reject(new Error("no network in tests")),
      agents: { sessions: [], conversation: () => Promise.resolve(null), reply: () => Promise.resolve(), configure: () => Promise.resolve() },
      launch: null,
      sessionFile: () => null,
      socketPath: "/tmp/x.sock",
      tellAstra: () => Promise.resolve(),
      broadcast: () => undefined,
      clock: systemClock,
      log: () => undefined,
      prGate: () => o.gate ?? null,
    });
  }

  it("goes through the gate as the device and GitHub account that asked", async () => {
    const asked: unknown[] = [];
    const gate: PrWritesGate = {
      preparePr: (deviceId, mutation, login) => {
        asked.push(["prepare", deviceId, mutation.kind, login]);
        return Promise.resolve({ ok: true, approval: { id: "a-1", expiresAt: 1, summary: "Merge now" } });
      },
      commitPr: (deviceId, req, login) => {
        asked.push(["commit", deviceId, req.approvalId, req.opId, login]);
        return Promise.resolve({ ok: true, outcome: { opId: req.opId, state: "done", result: { merge: "merged" } } });
      },
    };
    const service = reviews({ gate });
    expect(await service.handle({ kind: "prPrepare", login: ME, mutation: merge() }, "dev-9")).toEqual({ ok: true, approval: { id: "a-1", expiresAt: 1, summary: "Merge now" } });
    const id = opId();
    expect((await service.handle({ kind: "prCommit", login: ME, approvalId: "a-1", opId: id, mutation: merge() }, "dev-9")).outcome?.result?.merge).toBe("merged");
    expect(asked).toEqual([
      ["prepare", "dev-9", "merge", ME],
      ["commit", "dev-9", "a-1", id, ME],
    ]);
  });

  it("refuses on a test host and without an open gate", async () => {
    expect(await reviews({ writes: false, gate: null }).handle({ kind: "prPrepare", login: ME, mutation: merge() }, "d")).toEqual({ ok: false, refused: { code: "writesOff", message: DRY_RUN_ERROR } });
    expect((await reviews({ gate: null }).handle({ kind: "prCommit", login: ME, opId: opId(), mutation: merge() }, "d")).refused?.code).toBe("writesOff");
  });
});

describe("never --admin, never auto-merge", () => {
  it("no host source passes --admin, --auto or --disable-auto to gh", () => {
    const src = join(import.meta.dirname, "..", "src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const offenders = files.filter((f) => /["'`]--(admin|auto|disable-auto)["'`]/.test(readFileSync(join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
