import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentSession, AstraItem, ReviewQueue } from "@relay/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchOptions } from "../src/agents/herdr";
import { ASK_MARK, AstraSessions, seedPrompt, toTurns } from "../src/reviews/astra";
import type { ToolRun } from "../src/reviews/exec";
import { toItem, toPr, type RawPr } from "../src/reviews/github";
import { folderSections, guideCache, parseGuide, promptDiff } from "../src/reviews/guide";
import { handleReviewsMedia } from "../src/reviews/http";
import { linearItem, reasonOf, ReviewMedia, toRows as linearRows } from "../src/reviews/linear";
import { DRY_RUN_ERROR, ReviewsService, type ReviewsMessage, type ReviewsServiceDeps } from "../src/reviews/service";
import { sendLine, slackItem, slackLink, toRows as slackRows, toThread, tsMs } from "../src/reviews/slack";
import { systemClock } from "../src/session";
import { MAX_REVIEW_DIFF } from "@relay/protocol";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-reviews-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("github", () => {
  it("maps search rows to queue items by group", () => {
    const row = {
      number: 170,
      title: "Lock edits",
      html_url: "https://github.com/eCardSystems/api/pull/170",
      repository_url: "https://api.github.com/repos/eCardSystems/api",
      user: { login: "todd" },
      updated_at: "2026-10-30T10:00:00Z",
      draft: true,
    };
    expect(toItem(row, "needs")).toEqual({
      url: row.html_url,
      ref: { kind: "github", repo: "eCardSystems/api", number: 170 },
      title: "Lock edits",
      actor: "todd",
      reason: "requested your review",
      label: "#170",
      updatedAt: Date.parse("2026-10-30T10:00:00Z"),
      unread: true,
      draft: true,
      group: "needs",
    });
    expect(toItem({ ...row, user: null }, "reviewing")).toMatchObject({ actor: "ghost", reason: "updated since your review", group: "reviewing" });
  });

  it("maps a PR with commits in the timeline, checks failing first, and a cut diff", () => {
    const raw: RawPr = {
      number: 7,
      title: "T",
      url: "https://github.com/o/r/pull/7",
      state: "OPEN",
      isDraft: false,
      author: { login: "todd" },
      createdAt: "2026-10-30T09:00:00Z",
      updatedAt: "2026-10-30T12:00:00Z",
      body: "b",
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "abcdef1234567890",
      additions: 3,
      deletions: 1,
      commits: [{ oid: "1234567890abcdef", messageHeadline: "feat: lock", authoredDate: "2026-10-30T10:00:00Z", authors: [{ login: "todd", name: "Todd" }] }],
      files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
      reviewRequests: [{ login: "iweber" }],
      latestReviews: [{ author: { login: "noah" }, state: "APPROVED" }],
      reviews: [
        { author: { login: "noah" }, state: "APPROVED", body: "", submittedAt: "2026-10-30T11:00:00Z" },
        { author: { login: "noah" }, state: "COMMENTED", body: " ", submittedAt: "2026-10-30T11:30:00Z" },
      ],
      comments: [{ author: null, body: "hi", createdAt: "2026-10-30T09:30:00Z" }],
      assignees: [{ login: "todd" }],
      labels: [{ name: "api", color: "fff" }],
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS" },
        { context: "ci", state: "FAILURE", targetUrl: "https://ci" },
      ],
    };
    const pr = toPr("o/r", raw, "x".repeat(MAX_REVIEW_DIFF + 5));
    expect(pr.headSha).toBe("abcdef1234567890");
    expect(pr.timeline.map((t) => [t.kind, t.author, t.body, t.state])).toEqual([
      ["comment", "ghost", "hi", null],
      ["commit", "todd", "feat: lock", "1234567"],
      ["review", "noah", "", "APPROVED"],
    ]);
    expect(pr.reviewers).toEqual([
      { login: "iweber", state: "PENDING" },
      { login: "noah", state: "APPROVED" },
    ]);
    expect(pr.checks.map((c) => [c.name, c.state, c.url])).toEqual([
      ["ci", "fail", "https://ci"],
      ["lint", "pass", null],
    ]);
    expect(pr.files).toEqual([{ path: "src/a.ts", additions: 3, deletions: 1, change: "MODIFIED" }]);
    expect(pr.diff).toHaveLength(MAX_REVIEW_DIFF);
    expect(pr.diffTruncated).toBe(true);
    expect(toPr("o/r", raw, "diff").diffTruncated).toBe(false);
  });
});

describe("linear", () => {
  const me = { id: "me", name: "Isaac Weber", displayName: "iweber" };
  const steve = { id: "s", name: "Steve Arms", displayName: "sarms" };
  const issue = (key: string, type = "started", mine: string[] = []) => ({
    identifier: key,
    title: `T ${key}`,
    url: `https://linear.app/x/issue/${key}`,
    state: { type },
    comments: { nodes: mine.map((createdAt) => ({ createdAt, user: { id: "me" } })) },
  });
  const n = (type: string, at: string, opts: Record<string, unknown> = {}) => ({
    type,
    createdAt: at,
    readAt: null,
    archivedAt: null,
    actor: steve,
    issue: issue("ENG-1"),
    ...opts,
  });

  it("counts mentions, comments and replies as asks, never assignments or status changes", () => {
    expect(reasonOf("issueCommentMention")).toBe("mentioned you");
    expect(reasonOf("issueNewComment")).toBe("commented");
    expect(reasonOf("issueAssignedToYou")).toBeNull();
    expect(reasonOf("issueStatusChanged")).toBeNull();
    expect(reasonOf("issueCommentReaction")).toBeNull();
  });

  it("keeps tickets with an unanswered ask from someone else, one row each, newest first", () => {
    const rows = linearRows({
      viewer: me,
      notifications: {
        nodes: [
          n("issueCommentMention", "2026-10-30T10:00:00Z", { readAt: "2026-10-30T11:00:00Z" }),
          n("issueNewComment", "2026-10-30T09:00:00Z"),
          n("issueAssignedToYou", "2026-10-30T15:00:00Z", { issue: issue("ENG-7") }),
          n("issueCommentMention", "2026-10-30T12:00:00Z", { actor: me, issue: issue("ENG-2") }),
          n("issueNewComment", "2026-10-30T12:00:00Z", { issue: issue("ENG-3"), archivedAt: "2026-10-30T13:00:00Z" }),
          n("issueNewComment", "2026-10-30T12:00:00Z", { issue: issue("ENG-4", "completed") }),
          // He answered after Steve's comment: gone until the next ask.
          n("issueNewComment", "2026-10-30T12:00:00Z", { issue: issue("ENG-5", "started", ["2026-10-30T12:30:00Z"]) }),
          // He commented before the mention: still waiting on him.
          n("issueCommentMention", "2026-10-30T08:00:00Z", { issue: issue("ENG-6", "unstarted", ["2026-10-30T07:00:00Z"]) }),
        ],
      },
    });
    expect(rows.map((r) => [r.key, r.reason, r.actor, r.unread])).toEqual([
      ["ENG-1", "mentioned you", "Steve Arms", true],
      ["ENG-6", "mentioned you", "Steve Arms", true],
    ]);
    expect(rows[0]?.updatedAt).toBe(Date.parse("2026-10-30T10:00:00Z"));
    expect(rows[1] === undefined ? null : linearItem(rows[1])).toEqual({
      url: "https://linear.app/x/issue/ENG-6",
      ref: { kind: "linear", key: "ENG-6" },
      title: "T ENG-6",
      actor: "Steve Arms",
      reason: "mentioned you",
      label: "ENG-6",
      updatedAt: Date.parse("2026-10-30T08:00:00Z"),
      unread: true,
      stateType: "unstarted",
    });
  });
});

describe("slack", () => {
  it("reads the connector answer as one row per thread or DM, newest first", () => {
    const answer = `Here you go: {"me":"U1","items":[
      {"kind":"dm","channel":"D1","channel_name":"Chris Forbis","thread_ts":null,"ts":"1793389459.456979","author":"Chris Forbis","text":"We might need Sage","permalink":"https://ecardplatform.slack.com/archives/D1/p1793389459456979"},
      {"kind":"mention","channel":"C1","channel_name":"#ui-ux","thread_ts":"1793368143.899439","ts":"1793368143.899439","author":"Todd","text":"FYI @Isaac Weber","permalink":""},
      {"kind":"reply","channel":"C1","channel_name":"#ui-ux","thread_ts":"1793368143.899439","ts":"1793368100.000001","author":"Noah","text":"older","permalink":""},
      {"kind":"reply","channel":"not-an-id","ts":"1.2"},
      null
    ]}`;
    const rows = slackRows(answer);
    expect(rows.map((r) => [r.kind, r.channel, r.threadTs, r.author, r.url])).toEqual([
      ["dm", "D1", null, "Chris Forbis", "https://ecardplatform.slack.com/archives/D1"],
      ["mention", "C1", "1793368143.899439", "Todd", "https://ecardplatform.slack.com/archives/C1/p1793368143899439"],
    ]);
    expect(rows[0]?.updatedAt).toBe(tsMs("1793389459.456979"));
    expect(() => slackRows("no json")).toThrow(/no JSON/);
    expect(rows.map((r) => slackItem(r)).map((i) => [i.title, i.actor, i.reason, i.label, i.slackKind, i.ref])).toEqual([
      ["We might need Sage", "Chris Forbis", "asked you", "DM", "dm", { kind: "slack", channel: "D1", threadTs: null }],
      ["FYI @Isaac Weber", "Todd", "mentioned you", "#ui-ux", "mention", { kind: "slack", channel: "C1", threadTs: "1793368143.899439" }],
    ]);
  });

  it("reads a thread oldest first and marks his own messages", () => {
    const t = toThread(
      `{"me":"U1","channel_name":"#ui-ux","messages":[
        {"ts":"2.0","author":"Isaac","author_id":"U1","text":"me","mentions_me":false,"reactions":[],"files":[]},
        {"ts":"1.0","author":"Todd","author_id":"U2","text":"@Isaac look","mentions_me":true,"reactions":[{"emoji":"👍","count":2}],"files":[{"name":"a.png"}]}
      ]}`,
      "C1",
      "1.0",
    );
    expect(t.messages.map((m) => [m.author, m.mine, m.mentionsMe, m.files, m.reactions.length])).toEqual([
      ["Todd", false, true, ["a.png"], 1],
      ["Isaac", true, false, [], 0],
    ]);
  });

  it("hands Astra the exact text with where it goes", () => {
    expect(sendLine("C1", "1.5", "Ship it\nafter QA")).toBe("Slack send request: channel=C1 thread_ts=1.5 text=Ship it\nafter QA");
    expect(sendLine("D1", null, "Yes")).toBe("Slack send request: channel=D1 thread_ts=none text=Yes");
    expect(slackLink("https://x.slack.com", "D1", null)).toBe("https://x.slack.com/archives/D1");
  });
});

describe("guide", () => {
  const PATHS = ["src/a/policy.ts", "src/a/route.ts", "tests/a.test.ts", "README.md"];

  it("keeps the model sections over exactly the PR files", () => {
    const text = `Here it is: {"sections":[
      {"title":"Policy","why":"Edits lock at 30 minutes.","files":["src/a/policy.ts","nope.ts"]},
      {"title":"Endpoint","files":["src/a/route.ts","src/a/policy.ts"]},
      {"title":"Empty","why":"x","files":["ghost.ts"]},
      {"why":"no title","files":["README.md"]}
    ]}`;
    expect(parseGuide(text, PATHS)).toEqual([
      { title: "Policy", why: "Edits lock at 30 minutes.", files: ["src/a/policy.ts"] },
      { title: "Endpoint", why: "", files: ["src/a/route.ts"] },
      { title: "Other changes", why: "", files: ["tests/a.test.ts", "README.md"] },
    ]);
    expect(parseGuide("no json here", PATHS)).toBeNull();
    expect(parseGuide('{"sections":[{"title":"x","files":["ghost.ts"]}]}', PATHS)).toBeNull();
  });

  it("falls back to folders, source first", () => {
    expect(folderSections(PATHS).map((s) => [s.title, s.files])).toEqual([
      ["src/a", ["src/a/policy.ts", "src/a/route.ts"]],
      ["tests", ["tests/a.test.ts"]],
      ["Top-level files", ["README.md"]],
    ]);
  });

  it("cuts a long file diff", () => {
    const big = `diff --git a/x b/x\n${"+y\n".repeat(10_000)}diff --git a/z b/z\n+z\n`;
    const out = promptDiff(big);
    expect(out).toContain("[... rest of this file's diff cut]");
    expect(out).toContain("diff --git a/z b/z");
  });

  it("writes once per head, keeps only written guides, and falls back on failure", async () => {
    const file = join(dir, "guides.json");
    const input = { title: "t", body: "", diff: "", files: PATHS.map((p) => ({ path: p, additions: 1, deletions: 0 })) };
    const write = vi.fn(() => Promise.resolve('{"sections":[{"title":"All","why":"w","files":["src/a/policy.ts"]}]}'));
    const read = guideCache(file, write);
    const [a, b] = await Promise.all([read("o/r#1", "sha1", input), read("o/r#1", "sha1", input)]);
    expect(a).toEqual(b);
    expect(a.source).toBe("model");
    expect((await read("o/r#1", "sha1", input)).sections[0]?.title).toBe("All");
    expect(write).toHaveBeenCalledTimes(1);

    const failing = guideCache(file, () => Promise.reject(new Error("Claude took too long")));
    const fb = await failing("o/r#1", "sha2", input);
    expect(fb).toMatchObject({ source: "folders", error: "Claude took too long" });
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)).toEqual(["o/r#1@sha1"]);
  });
});

const message = (id: string, role: AgentMessage["role"], text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role, text, at: 0, ...extra });

describe("astra turns", () => {
  it("seeds a new item session with her prime, memory, the item, then the question", () => {
    const seed = seedPrompt({
      prime: "You are Astra.",
      memory: "Isaac is on ENG-6312.",
      title: "Astra · repo#170",
      label: "repo#170",
      url: "https://github.com/o/repo/pull/170",
      context: "### Pull request o/repo#170",
      question: "@Astra is it safe?",
    });
    expect(seed.startsWith("You are Astra.")).toBe(true);
    expect(seed).toContain("This session is not your main thread");
    expect(seed).toContain("Relay on his phone");
    expect(seed).toContain('"Astra · repo#170"');
    expect(seed).toContain("Isaac is on ENG-6312.");
    expect(seed.indexOf("### Pull request")).toBeLessThan(seed.lastIndexOf(ASK_MARK));
    expect(seed.endsWith(`${ASK_MARK}@Astra is it safe?`)).toBe(true);
  });

  it("shows only his words for the seed, a line per tool, and no notices", () => {
    const turns = toTurns([
      message("u1", "user", `prime and item${ASK_MARK}@Astra is it safe?`),
      message("s1", "system", "Context refreshed"),
      message("x1", "tool", "read src/a.ts", { tool: { name: "read", summary: "src/a.ts\nmore" } }),
      message("a1", "assistant", "Mostly. **One risk**.", { streaming: true }),
      message("a2", "assistant", ""),
      message("u2", "user", "@Astra which file first?"),
    ]);
    expect(turns.map((t) => [t.role, t.text, t.streaming])).toEqual([
      ["user", "@Astra is it safe?", false],
      ["tool", "read src/a.ts", false],
      ["assistant", "Mostly. **One risk**.", true],
      ["user", "@Astra which file first?", false],
    ]);
  });
});

describe("astra sessions", () => {
  const session = (id: string, status: AgentSession["status"], statusDetail?: string): AgentSession => ({
    id,
    provider: "omp",
    title: "Astra · o/r#1",
    projectPath: "/eva",
    status,
    lastActivity: "",
    lastActivityAt: 0,
    canRespond: true,
    ...(statusDetail === undefined ? {} : { statusDetail }),
  });

  it("launches a seeded session through the bridge, then sends later asks to it and pushes its changes", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".omp", "assistant", "agents", "astra"), { recursive: true });
    writeFileSync(join(home, ".omp", "assistant", "agents.json"), JSON.stringify({ agents: [{ id: "astra", title: "Astra", profile: "work", model: "claude-opus" }] }));
    writeFileSync(join(home, ".omp", "assistant", "agents", "astra", "prime.md"), "You are Astra.");
    const launches: LaunchOptions[] = [];
    let join_: (id: string) => void = () => undefined;
    const sessions: AgentSession[] = [];
    const replies: string[] = [];
    const named: string[] = [];
    const conversation: AgentMessage[] = [];
    const emitted: AstraItem[] = [];
    const astra = new AstraSessions({
      agents: {
        sessions,
        conversation: () => Promise.resolve(conversation),
        reply: (id, text) => {
          replies.push(`${id}:${text}`);
          return Promise.resolve();
        },
        configure: (change) => {
          named.push(`${change.sessionId}:${change.title ?? ""}`);
          return Promise.resolve();
        },
      },
      launch: (options) => {
        launches.push(options);
        return Promise.resolve({ joined: new Promise<string>((resolve) => (join_ = resolve)) });
      },
      sessionFile: () => "/sessions/s1.jsonl",
      agentHome: home,
      socketPath: "/tmp/test-agents.sock",
      storePath: join(dir, "astra.json"),
      emit: (item) => emitted.push(item),
      clock: systemClock,
      log: () => undefined,
    });
    const url = "https://github.com/o/r/pull/1";
    const first = await astra.ask(url, "Astra · o/r#1", "o/r#1", () => Promise.resolve("### Pull request o/r#1"), "@Astra is it safe?");
    expect(first).toMatchObject({ url, title: "Astra · o/r#1", sessionId: null, working: true, turns: [{ role: "user", text: "@Astra is it safe?" }] });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ label: "Astra · o/r#1", profile: "work", model: "claude-opus", ompArgs: ["--no-title"], env: { RELAY_AGENTS_SOCKET: "/tmp/test-agents.sock" } });
    expect(launches[0]?.env).not.toHaveProperty("RELAY_ASSISTANT");
    expect(launches[0]?.prompt).toContain("### Pull request o/r#1");
    expect(launches[0]?.prompt?.endsWith(`${ASK_MARK}@Astra is it safe?`)).toBe(true);

    sessions.push(session("s1", "working"));
    conversation.push(message("m1", "user", launches[0]?.prompt ?? ""), message("m2", "assistant", "Mostly."));
    join_("s1");
    await vi.waitFor(() => {
      expect(emitted.at(-1)).toMatchObject({ sessionId: "s1", working: true });
    });
    expect(emitted.at(-1)?.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "@Astra is it safe?"],
      ["assistant", "Mostly."],
    ]);
    expect(JSON.parse(readFileSync(join(dir, "astra.json"), "utf8"))).toEqual({ [url]: { title: "Astra · o/r#1", sessionFile: "/sessions/s1.jsonl", sessionId: "s1" } });
    expect(named).toEqual(["s1:Astra · o/r#1"]);

    sessions.splice(0, 1, session("s1", "needs_permission", "bash: rm"));
    astra.observe({ kind: "sessions" });
    await vi.waitFor(() => {
      expect(emitted.at(-1)?.waiting).toBe("Waiting for your approval: bash: rm");
    });

    await astra.ask(url, "Astra · o/r#1", "o/r#1", () => Promise.reject(new Error("unused")), "which file first?");
    expect(replies).toEqual(["s1:which file first?"]);
    expect(launches).toHaveLength(1);
    astra.stop();
  });

  it("keeps the question showing, Astra working, while a new session has no turns yet", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".omp", "assistant", "agents", "astra"), { recursive: true });
    writeFileSync(join(home, ".omp", "assistant", "agents.json"), JSON.stringify({ agents: [{ id: "astra", title: "Astra" }] }));
    writeFileSync(join(home, ".omp", "assistant", "agents", "astra", "prime.md"), "You are Astra.");
    let join_: (id: string) => void = () => undefined;
    const sessions: AgentSession[] = [];
    const conversation: AgentMessage[] = [];
    const emitted: AstraItem[] = [];
    let prompt = "";
    const astra = new AstraSessions({
      agents: { sessions, conversation: () => Promise.resolve(conversation), reply: () => Promise.resolve(), configure: () => Promise.resolve() },
      launch: (options) => {
        prompt = options.prompt ?? "";
        return Promise.resolve({ joined: new Promise<string>((resolve) => (join_ = resolve)) });
      },
      sessionFile: () => null,
      agentHome: home,
      socketPath: "/tmp/x.sock",
      storePath: join(dir, "astra.json"),
      emit: (item) => emitted.push(item),
      clock: systemClock,
      log: () => undefined,
    });
    const url = "https://linear.app/x/issue/ENG-1";
    await astra.ask(url, "Astra · ENG-1", "ENG-1", () => Promise.resolve("### Linear ticket ENG-1"), "@Astra what now?");
    // omp registered idle; its first prompt is not in the transcript yet.
    sessions.push(session("s1", "idle"));
    join_("s1");
    await vi.waitFor(() => {
      expect(emitted.at(-1)).toMatchObject({ sessionId: "s1", working: true, turns: [{ id: "pending", role: "user", text: "@Astra what now?" }] });
    });
    conversation.push(message("m1", "user", prompt), message("m2", "assistant", "Reply to Todd."));
    sessions.splice(0, 1, session("s1", "working"));
    astra.observe({ kind: "sessions" });
    await vi.waitFor(() => {
      expect(emitted.at(-1)?.turns.map((t) => [t.id, t.text])).toEqual([
        ["m1", "@Astra what now?"],
        ["m2", "Reply to Todd."],
      ]);
    });
    astra.stop();
  });

  it("refuses asks without an agent home", async () => {
    const astra = new AstraSessions({
      agents: { sessions: [], conversation: () => Promise.resolve(null), reply: () => Promise.resolve(), configure: () => Promise.resolve() },
      launch: null,
      sessionFile: () => null,
      agentHome: null,
      socketPath: "/tmp/x.sock",
      storePath: join(dir, "astra.json"),
      emit: () => undefined,
      clock: systemClock,
      log: () => undefined,
    });
    await expect(astra.ask("u", "Astra · x", "x", () => Promise.resolve(""), "q")).rejects.toThrow("--agent-home");
    expect(await astra.snapshot("u")).toBeNull();
  });
});

describe("service", () => {
  const searchRow = {
    number: 1,
    title: "PR one",
    html_url: "https://github.com/eCardSystems/api/pull/1",
    repository_url: "https://api.github.com/repos/eCardSystems/api",
    user: { login: "todd" },
    updated_at: "2026-10-30T10:00:00Z",
  };

  function service(overrides: Partial<ReviewsServiceDeps> = {}, slackGate: Promise<void> = Promise.resolve()): { reviews: ReviewsService; sent: ReviewsMessage[]; calls: string[][]; told: string[] } {
    vi.stubEnv("LINEAR_API_KEY", "");
    const sent: ReviewsMessage[] = [];
    const calls: string[][] = [];
    const told: string[] = [];
    const run: ToolRun = (argv) => {
      calls.push([...argv]);
      if (argv[0] === "gh" && argv.includes("search/issues")) {
        const needs = argv.some((a) => a.includes("review-requested:@me") && !a.includes("-review-requested"));
        return Promise.resolve({ code: 0, stdout: JSON.stringify({ items: needs ? [searchRow] : [] }), stderr: "", timedOut: false });
      }
      if (argv[0] === "claude") return slackGate.then(() => ({ code: 1, stdout: "", stderr: "", timedOut: false }));
      return Promise.resolve({ code: 1, stdout: "", stderr: "not here", timedOut: false });
    };
    const reviews = new ReviewsService({
      dir,
      agentHome: null,
      writes: true,
      run,
      gh: "gh",
      claude: "claude",
      fetch: () => Promise.reject(new Error("no network in tests")),
      agents: { sessions: [], conversation: () => Promise.resolve(null), reply: () => Promise.resolve(), configure: () => Promise.resolve() },
      launch: null,
      sessionFile: () => null,
      socketPath: "/tmp/x.sock",
      tellAstra: (line) => {
        told.push(line);
        return Promise.resolve();
      },
      broadcast: (message) => sent.push(message),
      clock: systemClock,
      log: () => undefined,
      ...overrides,
    });
    return { reviews, sent, calls, told };
  }

  const queues = (sent: ReviewsMessage[]): ReviewQueue[] => sent.flatMap((m) => (m.t === "reviews.queue" ? [m.queue] : []));

  it("reads every source, keeps going past a failing one, and pushes when each finishes", async () => {
    let open: () => void = () => undefined;
    const { reviews, sent } = service({}, new Promise<void>((resolve) => (open = resolve)));
    const answer = await reviews.handle({ kind: "queue", refresh: false });
    expect(answer.ok).toBe(true);
    expect(answer.queue?.items.map((i) => [i.label, i.reason, i.group])).toEqual([["#1", "requested your review", "needs"]]);
    expect(answer.queue?.sources.github).toMatchObject({ loading: false, error: null });
    expect(answer.queue?.sources.linear.error).toMatch(/No Linear API key/);
    expect(answer.queue?.sources.slack.loading).toBe(true);
    open();
    await vi.waitFor(() => {
      expect(queues(sent).at(-1)?.sources.slack).toMatchObject({ loading: false, error: "claude exited 1" });
    });
    // The rows from before a failure stay.
    expect(queues(sent).at(-1)?.items).toHaveLength(1);
  });

  it("keeps Done in done.json (0600), pushes the queue, and reads it back", async () => {
    const { reviews, sent } = service();
    const url = "https://github.com/eCardSystems/api/pull/1";
    expect(await reviews.handle({ kind: "done", url, updatedAt: 42, done: true })).toEqual({ ok: true, done: { [url]: 42 } });
    expect(queues(sent).at(-1)?.done).toEqual({ [url]: 42 });
    const file = join(dir, "done.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ [url]: 42 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(service().reviews.queue().done).toEqual({ [url]: 42 });
    expect(await reviews.handle({ kind: "done", url, updatedAt: 42, done: false })).toEqual({ ok: true, done: {} });
  });

  it("refuses every write on a test host and posts nothing", async () => {
    const { reviews, calls, told } = service({ writes: false });
    for (const op of [
      { kind: "comment", repo: "o/r", number: 1, body: "hi" },
      { kind: "review", repo: "o/r", number: 1, event: "approve", body: "" },
      { kind: "linearComment", issueId: "id", parentId: null, body: "hi" },
      { kind: "slackSend", channel: "C1", threadTs: null, text: "hi" },
    ] as const) {
      expect(await reviews.handle(op)).toEqual({ ok: false, error: DRY_RUN_ERROR });
    }
    expect(calls).toEqual([]);
    expect(told).toEqual([]);
  });

  it("hands a Slack send to Astra's main thread as one line", async () => {
    const { reviews, told } = service();
    expect(await reviews.handle({ kind: "slackSend", channel: "C1", threadTs: "1.5", text: "Ship it" })).toEqual({ ok: true });
    expect(told).toEqual(["Slack send request: channel=C1 thread_ts=1.5 text=Ship it"]);
  });

  it("passes native emoji through unchanged to Astra's line and to gh", async () => {
    const { reviews, told, calls } = service();
    const text = "Ship it 🎬👍🏽 ✅ — thanks! 👨‍👩‍👧";
    await reviews.handle({ kind: "slackSend", channel: "C1", threadTs: null, text });
    expect(told).toEqual([`Slack send request: channel=C1 thread_ts=none text=${text}`]);
    await reviews.handle({ kind: "comment", repo: "o/r", number: 1, body: text });
    expect(calls.at(-1)).toEqual(["gh", "pr", "comment", "1", "-R", "o/r", "--body", text]);
  });

  it("answers a failing read with one line", async () => {
    const { reviews } = service();
    expect(await reviews.handle({ kind: "pr", repo: "o/r", number: 1 })).toEqual({ ok: false, error: "gh pr view failed: not here" });
    expect(await reviews.handle({ kind: "astra", url: "https://x" })).toEqual({ ok: true, astra: null });
  });
});

describe("media", () => {
  it("serves a downloaded image only for its token", async () => {
    const media = new ReviewMedia(join(dir, "media"));
    const name = `${"a".repeat(40)}.png`;
    mkdirSync(media.dir, { recursive: true });
    writeFileSync(join(media.dir, name), Buffer.from([1, 2, 3]));
    const path = media.path(name);
    expect(path).toMatch(new RegExp(`^/reviews/media/${name}/[0-9a-f]{32}$`));
    const token = path.split("/").at(-1) ?? "";
    expect(media.open(name, token)).toMatchObject({ mimeType: "image/png", size: 3, name });
    expect(media.open(name, "0".repeat(32))).toBeNull();
    expect(media.open("../secret.png", token)).toBeNull();
    // Another process's secret signs differently.
    expect(new ReviewMedia(media.dir).open(name, token)).toBeNull();

    const reviews = { handle: () => Promise.resolve({ ok: true }), openMedia: (n: string, t: string) => media.open(n, t), observe: () => undefined };
    const ok = handleReviewsMedia(reviews, new Request(`http://h${path}`), path);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const bad = `/reviews/media/${name}/${"0".repeat(32)}`;
    expect(handleReviewsMedia(reviews, new Request(`http://h${bad}`), bad).status).toBe(404);
    expect(handleReviewsMedia(null, new Request(`http://h${path}`), path).status).toBe(404);
  });
});
