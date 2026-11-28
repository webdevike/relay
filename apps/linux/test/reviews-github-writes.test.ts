import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrMutation, TicketMutation } from "@relay/protocol";
import type { ToolResult, ToolRun } from "../src/reviews/exec";
import { GitHub, ghGraphql } from "../src/reviews/github";
import { githubExecutor, RelayAutoMerge, relayAutoMergeWatch } from "../src/reviews/github-writes";
import { ReviewsService, DRY_RUN_ERROR, type PrWritesGate } from "../src/reviews/service";
import { MutationGate, type GateIdentity, type MutationExecutor } from "../src/tickets/gate";
import { GithubSync } from "../src/tickets/github-sync";
import type { TicketsStore } from "../src/tickets/store";
import { systemClock } from "../src/session";

const REPO = "eCardSystems/api";
const N = 42;
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const ME: GateIdentity = { linearViewerId: "viewer-isaac", ghLogin: "webdevike" };
const DEVICE = { deviceId: "device-1" };
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
  autoMerge: string | null;
  permission: string;
  methods: { merge: boolean; squash: boolean; rebase: boolean };
  requested: string[];
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
    autoMerge: null,
    permission: "WRITE",
    methods: { merge: true, squash: true, rebase: false },
    requested: [],
  };
  readonly runs = new Map<number, { head_sha: string; conclusion: string | null; run_attempt: number }>();
  readonly reactions = new Map<string, { id: number; login: string; content: string }[]>();
  readonly issueComments: Listed[] = [];
  readonly reviewComments: Listed[] = [];
  readonly calls: string[][] = [];
  /** The next write reaches GitHub but its answer is lost. */
  loseNext = false;
  private nextId = 100;

  readonly run: ToolRun = (argv) => {
    const args = argv.slice(1);
    this.calls.push(args);
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
        state: p.state,
        isDraft: p.isDraft,
        headRefOid: p.head,
        baseRefName: "main",
        mergeable: p.mergeable,
        mergeStateStatus: p.mergeStateStatus,
        isInMergeQueue: p.inQueue,
        isMergeQueueEnabled: p.queue,
        mergeQueueEntry: p.inQueue ? { state: "QUEUED" } : null,
        autoMergeRequest: p.autoMerge === null ? null : { mergeMethod: p.autoMerge, enabledBy: { login: "webdevike" } },
        latestReviews: { nodes: [{ author: { login: "todd" }, state: "APPROVED", submittedAt: "2026-11-27T10:00:00Z" }] },
        reviewRequests: { nodes: p.requested.map((login) => ({ requestedReviewer: { login } })) },
        commits: {
          nodes: [
            {
              commit: {
                oid: p.head,
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://x", checkSuite: { workflowRun: { databaseId: 7, runNumber: 3, workflow: { name: "CI" } } } }],
                  },
                },
              },
            },
          ],
        },
      },
    };
    return ok(`HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 4990\r\n\r\n${JSON.stringify({ data: { repository } })}`);
  }

  private rest(a: string[]): ToolResult {
    if (a[0] === "pr" || a[0] === "run") return this.ghWrite(a);
    const path = a.find((x) => x.startsWith("repos/")) ?? "";
    const run = /actions\/runs\/(\d+)$/.exec(path);
    if (run !== null) {
      const facts = this.runs.get(Number(run[1]));
      if (facts === undefined) return no("gh: Not Found (HTTP 404)");
      return ok(a.includes("--jq") ? String(facts.run_attempt) : JSON.stringify(facts));
    }
    if (path.endsWith("/reactions") || /\/reactions\/\d+$/.test(path)) return this.react(a, path);
    if (a.includes("GET")) return ok(this.listed(path).map((c) => JSON.stringify(c)).join("\n"));
    return this.post(a, path);
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
    if (a.includes("--disable-auto")) {
      this.pr.autoMerge = null;
      return ok();
    }
    if (a[a.indexOf("--match-head-commit") + 1] !== this.pr.head) return no("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)");
    const method = (a.find((x) => ["--merge", "--squash", "--rebase"].includes(x)) ?? "--merge").slice(2).toUpperCase();
    if (this.pr.queue) this.pr.inQueue = true;
    else if (a.includes("--auto") && !["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(this.pr.mergeStateStatus)) this.pr.autoMerge = method;
    else this.pr.state = "MERGED";
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

const noLinear: MutationExecutor<TicketMutation> = {
  check: () => Promise.reject(new Error("no Linear here")),
  run: () => Promise.reject(new Error("no Linear here")),
  reconcile: () => Promise.resolve("unknown"),
};

function setup(o: { writes?: boolean } = {}) {
  const gh = new FakeGh();
  const dir = mkdtempSync(join(tmpdir(), "relay-gh-writes-"));
  const autoMerge = new RelayAutoMerge(dir);
  const exec = githubExecutor({ run: gh.run, gh: "gh", graphql: ghGraphql(gh.run, "gh", null), budget: null, login: () => ME.ghLogin, autoMerge });
  const gate = new MutationGate({ dir, writesEnabled: () => o.writes ?? true, identity: () => ME, linear: noLinear, github: exec, now: () => T0, log: () => undefined });
  /** prepare (when confirmed) then commit. */
  const write = async (m: PrMutation, id = opId()) => {
    const prepared = await gate.preparePr(DEVICE, m, ME);
    const approvalId = prepared.approval?.id;
    return gate.commitPr(DEVICE, { opId: id, mutation: m, ...(approvalId === undefined ? {} : { approvalId }) }, ME);
  };
  return { gh, dir, autoMerge, exec, gate, write };
}

const merge = (over: Partial<Extract<PrMutation, { kind: "merge" }>> = {}): PrMutation => ({ kind: "merge", repo: REPO, number: N, method: "squash", intent: "merge", expectHead: H1, ...over });

describe("GitHub PR writes: argv per op", () => {
  it("merges with the method and the head it saw, never --admin", async () => {
    const { gh, write } = setup();
    const answer = await write(merge());
    expect(answer).toMatchObject({ ok: true, outcome: { state: "done", result: { merge: "merged" } } });
    expect(gh.writes()).toEqual([["pr", "merge", "42", "--repo", REPO, "--squash", "--match-head-commit", H1]]);
  });

  it("arms auto-merge with --auto, remembers the head, and turns it off with --disable-auto", async () => {
    const { gh, write, autoMerge } = setup();
    gh.pr.mergeStateStatus = "BLOCKED";
    expect(await write(merge({ intent: "auto" }))).toMatchObject({ ok: true, outcome: { result: { merge: "autoMergeArmed" } } });
    expect(autoMerge.armedHead(`${REPO}#42`)).toBe(H1);
    expect(await write({ kind: "autoMerge", repo: REPO, number: N, on: false, expectHead: H1 })).toMatchObject({ ok: true, outcome: { state: "done" } });
    expect(gh.writes()).toEqual([
      ["pr", "merge", "42", "--repo", REPO, "--squash", "--match-head-commit", H1, "--auto"],
      ["pr", "merge", "42", "--repo", REPO, "--disable-auto"],
    ]);
    expect(autoMerge.armedHead(`${REPO}#42`)).toBeUndefined();
  });

  it("re-runs a failed run of the head at its attempt", async () => {
    const { gh, write } = setup();
    gh.runs.set(7, { head_sha: H1, conclusion: "failure", run_attempt: 1 });
    expect(await write({ kind: "rerun", repo: REPO, number: N, runId: 7, attempt: 1, headSha: H1 })).toMatchObject({ ok: true, outcome: { state: "done" } });
    expect(gh.writes()).toEqual([["run", "rerun", "7", "--failed", "--repo", REPO]]);
    expect(gh.calls).toContainEqual(["api", `repos/${REPO}/actions/runs/7`]);
  });

  it("requests reviews, comments, review comments and replies with the exact text", async () => {
    const { gh, write } = setup();
    await write({ kind: "requestReview", repo: REPO, number: N, logins: ["todd", "eCardSystems/core"] });
    const commented = await write({ kind: "comment", repo: REPO, number: N, body: "Ship it" });
    expect(commented.outcome?.result?.url).toContain("#issuecomment-");
    const line = await write({ kind: "reviewComment", repo: REPO, number: N, commitId: H1, path: "src/a.ts", line: 12, side: "RIGHT", body: "Why?" });
    expect(line.outcome?.result).toMatchObject({ id: expect.any(String), url: expect.stringContaining("https://github.com/r/") });
    await write({ kind: "reviewReply", repo: REPO, number: N, commentId: 555, body: "Because" });
    expect(gh.writes()).toEqual([
      ["pr", "edit", "42", "--repo", REPO, "--add-reviewer", "todd,eCardSystems/core"],
      ["pr", "comment", "42", "--repo", REPO, "--body", "Ship it"],
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
    const prepared = await gate.preparePr(DEVICE, merge(), ME);
    expect(prepared.approval?.summary).toBe(`Merge now: ${REPO}#42 at aaaaaaa into main (squash)`);
    gh.pr.head = H2;
    const answer = await gate.commitPr(DEVICE, { opId: opId(), mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME);
    expect(answer.refused?.code).toBe("conflict");
    expect(answer.refused?.message).toContain("New commits since you looked");
    expect(gh.writes()).toEqual([]);
  });

  it("refuses conflict when the outcome changed since the confirm (auto-merge would now merge at once)", async () => {
    const { gh, gate } = setup();
    gh.pr.mergeStateStatus = "BLOCKED";
    const m = merge({ intent: "auto" });
    const prepared = await gate.preparePr(DEVICE, m, ME);
    expect(prepared.approval?.summary).toContain("Turn on auto-merge");
    gh.pr.mergeStateStatus = "CLEAN";
    const answer = await gate.commitPr(DEVICE, { opId: opId(), mutation: m, approvalId: prepared.approval?.id ?? "" }, ME);
    expect(answer.refused?.code).toBe("conflict");
    expect(gh.writes()).toEqual([]);
  });

  it.each([
    ["blocked", { mergeStateStatus: "BLOCKED" }, "invalid", "Required reviews or checks"],
    ["draft", { isDraft: true }, "invalid", "draft"],
    ["no permission", { permission: "READ" }, "invalid", "can't merge"],
    ["no method", { methods: { merge: true, squash: false, rebase: false } }, "invalid", "squash merges are off"],
    ["conflicts", { mergeable: "CONFLICTING" }, "invalid", "conflicts"],
    ["already merged", { state: "MERGED" }, "conflict", "already merged"],
    ["queue needs Add to merge queue", { queue: true }, "conflict", "This branch merges through a queue; use Add to merge queue"],
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
      { kind: "autoMerge", repo: REPO, number: N, on: true, method: "merge", expectHead: H1 },
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

  it("refuses an actor on another gh login", async () => {
    const { gh, gate } = setup();
    const answer = await gate.commitPr(DEVICE, { opId: opId(), mutation: merge() }, { ...ME, ghLogin: "someone-else" });
    expect(answer.refused?.code).toBe("identity");
    expect(gh.calls).toEqual([]);
  });
});

describe("GitHub PR writes: outcomes and desired state", () => {
  it("adds to the merge queue when the base requires one", async () => {
    const { gh, write } = setup();
    gh.pr.queue = true;
    gh.pr.mergeStateStatus = "BLOCKED";
    const answer = await write(merge({ intent: "auto" }));
    expect(answer).toMatchObject({ ok: true, outcome: { result: { merge: "queued" } } });
    expect(gh.writes()).toEqual([["pr", "merge", "42", "--repo", REPO, "--squash", "--match-head-commit", H1, "--auto"]]);
  });

  it("no-ops auto-merge on when it is already on, and off when it is already off", async () => {
    const { gh, write } = setup();
    gh.pr.mergeStateStatus = "BLOCKED";
    gh.pr.autoMerge = "SQUASH";
    expect(await write({ kind: "autoMerge", repo: REPO, number: N, on: true, method: "squash", expectHead: H1 })).toMatchObject({ ok: true, outcome: { result: { merge: "autoMergeArmed" } } });
    gh.pr.autoMerge = null;
    expect(await write({ kind: "autoMerge", repo: REPO, number: N, on: false, expectHead: H1 })).toMatchObject({ ok: true, outcome: { state: "done" } });
    expect(gh.writes()).toEqual([]);
  });

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
    const prepared = await gate.preparePr(DEVICE, m, ME);
    const id = opId();
    gh.loseNext = true;
    const lost = await gate.commitPr(DEVICE, { opId: id, mutation: m, approvalId: prepared.approval?.id ?? "" }, ME);
    expect(lost.outcome?.state).toBe("unknown");
    const retry = await gate.commitPr(DEVICE, { opId: id, mutation: m }, ME);
    expect(retry.outcome?.state).toBe("done");
    expect(gh.writes().filter((a) => a[1] === "comment")).toHaveLength(1);
  });

  it("reconciles a lost merge from GitHub's state", async () => {
    const { gh, gate } = setup();
    const prepared = await gate.preparePr(DEVICE, merge(), ME);
    const id = opId();
    gh.loseNext = true;
    expect((await gate.commitPr(DEVICE, { opId: id, mutation: merge(), approvalId: prepared.approval?.id ?? "" }, ME)).outcome?.state).toBe("unknown");
    expect((await gate.commitPr(DEVICE, { opId: id, mutation: merge() }, ME)).outcome?.state).toBe("done");
    expect(gh.writes()).toHaveLength(1);
  });

  it("keeps a GitHub refusal as failed (nothing written)", async () => {
    const { gh, exec } = setup();
    gh.pr.head = H2;
    await expect(exec.run(merge(), opId())).rejects.toMatchObject({ name: "ProviderRejected" });
  });
});

describe("PR read actions facts", () => {
  const raw = { number: N, title: "t", url: "u", state: "OPEN", isDraft: false, author: null, createdAt: "", updatedAt: "", body: "", baseRefName: "main", headRefName: "f", headRefOid: H1, additions: 0, deletions: 0, commits: [], files: [], reviewRequests: [], latestReviews: [], reviews: [], comments: [], assignees: [], labels: [], statusCheckRollup: [] };

  it("adds merge, queue, review and check facts, with each failed run's attempt", async () => {
    const gh = new FakeGh();
    gh.pr.autoMerge = "SQUASH";
    gh.runs.set(7, { head_sha: H1, conclusion: "failure", run_attempt: 2 });
    const run: ToolRun = (argv, options) => {
      if (argv[1] === "pr" && argv[2] === "view") return Promise.resolve(ok(JSON.stringify(raw)));
      if (argv[1] === "pr" && argv[2] === "diff") return Promise.resolve(ok(""));
      return gh.run(argv, options);
    };
    const pr = await new GitHub(run, "gh").pr(REPO, N);
    expect(pr.actions).toEqual({
      viewerPermission: "WRITE",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      methods: { merge: true, squash: true, rebase: false },
      autoMerge: { method: "squash", by: "webdevike" },
      mergeQueue: { required: false, inQueue: false, entryState: null },
      reviews: [{ login: "todd", state: "APPROVED", at: Date.parse("2026-11-27T10:00:00Z") }],
      checks: [{ name: "test", state: "fail", url: "https://x", workflow: "CI", runId: 7, runNumber: 3, attempt: 2, headSha: H1 }],
    });
    expect(gh.calls).toContainEqual(["api", `repos/${REPO}/actions/runs/7`, "--jq", ".run_attempt"]);
  });

  it("leaves actions out when GitHub can't say", async () => {
    const run: ToolRun = (argv) => Promise.resolve(argv[2] === "view" ? ok(JSON.stringify(raw)) : argv[2] === "diff" ? ok("") : no("boom"));
    expect((await new GitHub(run, "gh").pr(REPO, N)).actions).toBeUndefined();
  });
});

describe("Relay-armed auto-merge", () => {
  it("turns auto-merge off when the head moves and flags the PR for attention", async () => {
    const { gh, dir, exec, autoMerge, write } = setup();
    gh.pr.mergeStateStatus = "BLOCKED";
    await write(merge({ intent: "auto" }));
    gh.pr.head = H2;
    const watch = relayAutoMergeWatch(exec, autoMerge, () => undefined);
    const ref = { repo: REPO, number: N };
    await watch.headSeen(ref, H2, true);
    expect(gh.writes().at(-1)).toEqual(["pr", "merge", "42", "--repo", REPO, "--disable-auto"]);
    expect(watch.disarmed(ref)).toBe(true);
    expect(gh.pr.autoMerge).toBeNull();
    // The flag survives a restart; Relay arming it again clears it.
    expect(new RelayAutoMerge(dir).isDisarmed(`${REPO}#42`)).toBe(true);
    autoMerge.arm(`${REPO}#42`, H2);
    expect(watch.disarmed(ref)).toBe(false);
  });

  it("leaves auto-merge Relay didn't arm, or armed at the same head, alone", async () => {
    const { gh, exec, autoMerge } = setup();
    const watch = relayAutoMergeWatch(exec, autoMerge, () => undefined);
    await watch.headSeen({ repo: REPO, number: N }, H2, true);
    autoMerge.arm(`${REPO}#42`, H1);
    await watch.headSeen({ repo: REPO, number: N }, H1, true);
    expect(gh.writes()).toEqual([]);
  });

  it("github-sync sets relayAutoMergeDisarmed from the watch on a facts read", async () => {
    const ref = { repo: REPO, number: N };
    const fact = { number: N, title: "t", url: "u", state: "OPEN", isDraft: false, updatedAt: "2026-11-27T12:00:00Z", headRefOid: H2, reviewDecision: null, mergeStateStatus: "CLEAN", viewerDidAuthor: true, author: { login: "webdevike" }, commits: { nodes: [] }, reviewRequests: { nodes: [] }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } };
    const seen: string[] = [];
    const sync = new GithubSync(
      () => Promise.resolve({ data: { p0: { pullRequest: fact } }, errors: [] }),
      { linkedPrs: () => [ref], pr: () => undefined, setPr: (e: { input: { relayAutoMergeDisarmed: boolean } | null }) => seen.push(String(e.input?.relayAutoMergeDisarmed)) } as unknown as TicketsStore,
      { disarmed: () => true, headSeen: (_r, head) => Promise.resolve(void seen.push(head)) },
    );
    await sync.pass("webdevike");
    expect(seen).toEqual([H2, "true"]);
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

  it("goes through the gate as the device that asked", async () => {
    const asked: unknown[] = [];
    const gate: PrWritesGate = {
      preparePr: (deviceId, mutation) => {
        asked.push(["prepare", deviceId, mutation.kind]);
        return Promise.resolve({ ok: true, approval: { id: "a-1", expiresAt: 1, summary: "Merge now" } });
      },
      commitPr: (deviceId, req) => {
        asked.push(["commit", deviceId, req.approvalId, req.opId]);
        return Promise.resolve({ ok: true, outcome: { opId: req.opId, state: "done", result: { merge: "merged" } } });
      },
    };
    const service = reviews({ gate });
    expect(await service.handle({ kind: "prPrepare", mutation: merge() }, "dev-9")).toEqual({ ok: true, approval: { id: "a-1", expiresAt: 1, summary: "Merge now" } });
    const id = opId();
    expect((await service.handle({ kind: "prCommit", approvalId: "a-1", opId: id, mutation: merge() }, "dev-9")).outcome?.result?.merge).toBe("merged");
    expect(asked).toEqual([
      ["prepare", "dev-9", "merge"],
      ["commit", "dev-9", "a-1", id],
    ]);
  });

  it("refuses on a test host and without an open gate", async () => {
    expect(await reviews({ writes: false, gate: null }).handle({ kind: "prPrepare", mutation: merge() }, "d")).toEqual({ ok: false, refused: { code: "writesOff", message: DRY_RUN_ERROR } });
    expect((await reviews({ gate: null }).handle({ kind: "prCommit", opId: opId(), mutation: merge() }, "d")).refused?.code).toBe("writesOff");
  });
});

describe("never --admin", () => {
  it("no host source passes --admin to gh", () => {
    const src = join(import.meta.dirname, "..", "src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const offenders = files.filter((f) => /["'`]--admin["'`]/.test(readFileSync(join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
