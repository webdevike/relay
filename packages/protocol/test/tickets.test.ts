import { describe, expect, it } from "vitest";
import client from "../fixtures/client-messages.json";
import server from "../fixtures/server-messages.json";
import {
  CONFIRMED_TICKET_MUTATIONS,
  MAX_TICKET_TEXT,
  MAX_TICKET_WATCH,
  MAX_TICKETS,
  REVIEWS_ACTIONS_FEATURE,
  REVIEWS_GUIDE2_FEATURE,
  TICKETS_FEATURE,
  TICKETS_WRITES_FEATURE,
  TicketDetail,
  TicketMutation,
  TicketsOp,
  parseClientMessage,
  parseServerMessage,
  ticketMutationConfirmed,
  type ClientMessage,
  type ServerMessage,
  type TicketBoardFacts,
  type TicketsStatus,
} from "../src";

const OP = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const OP2 = "6f1c2a3e-8b7d-4c1e-9f0a-2b3c4d5e6f70";
const actor = { id: "u1", name: "Isaac Weber", avatarUrl: null };

const facts: TicketBoardFacts = {
  key: "ENG-1",
  id: "issue-1",
  documentContentId: "doc-1",
  title: "Board sync",
  url: "https://linear.app/ecard/issue/ENG-1",
  state: { id: "s1", name: "In Progress", type: "started", color: "#f2c94c" },
  team: { id: "t1", key: "ENG" },
  priority: 2,
  prioritySortOrder: -12.5,
  assignee: actor,
  creator: { id: "u2", name: "Nova", avatarUrl: "https://example.com/a.png" },
  labels: [{ id: "l1", name: "Bug", color: "#eb5757" }],
  project: { id: "p1", name: "Relay", targetDate: "2026-12-15" },
  milestone: { id: "m1", name: "Beta", targetDate: null, sortOrder: 1 },
  parent: null,
  children: [{ id: "issue-2", key: "ENG-2", title: "Child", done: true }],
  relations: [{ id: "issue-3", key: "ENG-3", title: "Blocker", kind: "blockedBy" }],
  prs: [{ repo: "ecard/relay", number: 12 }],
  dueDate: "2026-12-01",
  plannedStart: "2026-11-20",
  startedAt: 1_700_000_000_000,
  createdAt: 1_690_000_000_000,
  updatedAt: 1_700_000_100_000,
  subscribed: true,
  prFacts: [
    {
      repo: "ecard/relay",
      number: 12,
      title: "Sync tickets",
      url: "https://github.com/ecard/relay/pull/12",
      author: "webdevike",
      state: "open",
      draft: false,
      checks: { state: "pass", passed: 4, failed: 0, pending: 0 },
      decision: "APPROVED",
      mergeState: "CLEAN",
      headSha: "abc123",
      updatedAt: 1_700_000_200_000,
    },
  ],
  attention: {
    waiting: [
      {
        provider: "linear",
        itemId: "ENG-1",
        rootId: "c1",
        commentId: "c3",
        author: { id: "u2", name: "Nova", avatarUrl: null },
        at: 1_700_000_300_000,
        excerpt: "@isaac can you check this?",
        count: 2,
        anchor: { kind: "inline", documentContentId: "doc-1", quotedText: "sync" },
      },
      {
        provider: "github",
        itemId: "ecard/relay#12",
        rootId: "r1",
        commentId: "r1",
        author: { id: "octo", name: "octo", avatarUrl: null },
        at: 1_700_000_400_000,
        excerpt: "@webdevike this line?",
        count: 1,
        anchor: {
          kind: "pr-review-line",
          pr: { repo: "ecard/relay", number: 12 },
          path: "src/a.ts",
          line: 4,
          side: "RIGHT",
        },
      },
    ],
    needsYou: {
      kind: "merge",
      text: "Merge PR #12",
      action: { kind: "merge", label: "Merge", pr: { repo: "ecard/relay", number: 12 } },
      evidence: "abc123:APPROVED",
    },
  },
};

const status: TicketsStatus = {
  identity: {
    linear: { viewerId: "u1", name: "Isaac Weber", email: "isaac@example.com", org: "eCard" },
    github: { login: "webdevike" },
  },
  features: { tickets: true, writes: false },
  freshness: { lastSyncAt: 1_700_000_500_000, lastError: null, state: "waiting" },
  errors: { linear: null, github: "No access to ecard/secret" },
  budget: {
    linear: { remaining: 1200, resetAt: 1_700_003_600_000, backoffUntil: null },
    github: { remaining: null, resetAt: null, backoffUntil: 1_700_000_600_000 },
  },
};

const detail: TicketDetail = {
  ...facts,
  description: "Sync the board.",
  comments: [
    {
      id: "c1",
      parentId: null,
      documentContentId: "doc-1",
      quotedText: "sync",
      author: { id: "u2", name: "Nova", avatarUrl: null },
      body: "@isaac can you check this?",
      at: 1_700_000_300_000,
      editedAt: null,
      resolvedAt: null,
      resolvingUser: null,
      reactions: [{ emoji: "+1", users: [actor] }],
      url: "https://linear.app/ecard/issue/ENG-1#comment-c1",
    },
  ],
};

const mutations: TicketMutation[] = [
  { kind: "setState", issueId: "issue-1", fromStateId: "s1", toStateId: "s2" },
  {
    kind: "comment",
    issueId: "issue-1",
    documentContentId: "doc-1",
    parentId: "c1",
    quotedText: "sync",
    body: "Looks right.",
  },
  { kind: "comment", issueId: "issue-1", body: "Plain comment." },
  { kind: "editComment", commentId: "c4", body: "Edited." },
  { kind: "deleteComment", commentId: "c1", replyCount: 3 },
  { kind: "resolve", rootId: "c1", on: true },
  { kind: "react", commentId: "c1", emoji: "+1", on: false },
  { kind: "subscribe", issueId: "issue-1", on: false },
  {
    kind: "createIssue",
    teamId: "t1",
    stateId: "todo",
    templateId: "tpl",
    projectId: null,
    title: "Follow up",
    description: "From a comment.",
    sourceCommentId: "c1",
    referenceCommentId: "c1",
  },
  {
    kind: "applyPlan",
    rows: [
      {
        key: "ENG-1",
        issueId: "issue-1",
        opId: OP2,
        baseUpdatedAt: 1_700_000_100_000,
        dueDate: "2026-12-03",
        priority: 1,
        prioritySortOrder: 3.5,
        plannedStart: null,
      },
    ],
  },
];

const ops: TicketsOp[] = [
  { kind: "board" },
  { kind: "ticket", key: "ENG-1" },
  { kind: "subscribe", on: true },
  { kind: "watch", keys: ["ENG-1", "OPS-22"], ttlMs: 600_000 },
  { kind: "sync" },
  { kind: "seen", key: "ENG-1" },
  {
    kind: "handled",
    target: { kind: "mention", provider: "linear", itemId: "ENG-1", throughCommentId: "c3" },
  },
  {
    kind: "handled",
    target: { kind: "needs", itemId: "ENG-1", reasonKind: "merge", evidence: "abc123:APPROVED" },
    undo: true,
  },
  { kind: "summary", key: "ENG-1" },
  ...mutations.map((mutation) => ({ kind: "prepare" as const, viewerId: "u1", mutation })),
  ...mutations.map((mutation) => ({
    kind: "commit" as const,
    viewerId: "u1",
    opId: OP,
    mutation,
  })),
  { kind: "commit", viewerId: "u1", approvalId: "ap1", opId: OP, mutation: mutations[1]! },
  { kind: "plan", rows: [{ key: "ENG-1", plannedStart: "2026-11-21" }] },
  { kind: "replan", projectId: "p1" },
  { kind: "replan", projectId: "p1", milestoneId: "m1" },
];

function roundTripClient(m: ClientMessage): void {
  const r = parseClientMessage(JSON.stringify(m));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (r.ok) expect(r.value).toEqual(m);
}

function roundTripServer(m: ServerMessage): void {
  const r = parseServerMessage(JSON.stringify(m));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (r.ok) expect(r.value).toEqual(m);
}

describe("tickets frames", () => {
  it("round-trips every op and every mutation kind", () => {
    const kinds = new Set(ops.map((op) => op.kind));
    expect([...kinds].sort()).toEqual(TicketsOp.options.map((o) => o.shape.kind.value).sort());
    expect(mutations.map((m) => m.kind).sort()).toEqual(
      [...new Set(TicketMutation.options.map((o) => o.shape.kind.value)), "comment"].sort(),
    );
    ops.forEach((op, i) => roundTripClient({ t: "tickets.req", rid: `r${String(i)}`, op }));
  });

  it("round-trips every result field and push", () => {
    roundTripServer({ t: "tickets.res", rid: "r1", ok: true, board: { tickets: [facts] }, rev: 7 });
    roundTripServer({ t: "tickets.res", rid: "r2", ok: true, ticket: detail });
    roundTripServer({
      t: "tickets.res",
      rid: "r3",
      ok: true,
      approval: { id: "ap1", expiresAt: 1_700_000_120_000, summary: 'Post "Looks right."' },
    });
    roundTripServer({
      t: "tickets.res",
      rid: "r4",
      ok: true,
      outcome: {
        opId: OP,
        state: "done",
        result: {
          id: "issue-9",
          key: "ENG-9",
          url: "https://linear.app/ecard/issue/ENG-9",
          rows: [{ key: "ENG-1", opId: OP2, state: "failed", error: "Changed in Linear" }],
        },
      },
    });
    roundTripServer({
      t: "tickets.res",
      rid: "r5",
      ok: true,
      outcome: { opId: OP, state: "unknown" },
    });
    roundTripServer({
      t: "tickets.res",
      rid: "r6",
      ok: false,
      error: "Changed in Linear since you looked",
      refused: { code: "conflict", message: "Changed in Linear since you looked" },
    });
    roundTripServer({ t: "tickets.res", rid: "r7", ok: true, previousSeenAt: null });
    roundTripServer({ t: "tickets.res", rid: "r8", ok: true, previousSeenAt: 1_700_000_000_000 });
    roundTripServer({
      t: "tickets.res",
      rid: "r9",
      ok: true,
      summary: { key: "ENG-1", text: null, at: 1_700_000_000_000 },
      status,
    });
    roundTripServer({
      t: "tickets.res",
      rid: "r10",
      ok: true,
      proposal: {
        summary: "Pull ENG-1 in.",
        changes: [{ key: "ENG-1", start: "2026-11-20", dueDate: "2026-11-30", reason: "Urgent" }],
      },
    });
    for (const code of [
      "writesOff",
      "identity",
      "approval",
      "unknownOutcome",
      "invalid",
    ] as const) {
      roundTripServer({ t: "tickets.res", rid: "r", ok: false, refused: { code, message: code } });
    }
    roundTripServer({ t: "tickets.snapshot", rev: 7, board: { tickets: [facts] }, status });
    roundTripServer({
      t: "tickets.delta",
      rev: 8,
      base: 7,
      upserts: [{ ...facts, attention: { waiting: [], needsYou: null } }],
      tombstones: ["ENG-4"],
    });
    roundTripServer({ t: "tickets.delta", rev: 9, base: 8, upserts: [], tombstones: [], status });
    roundTripServer({
      t: "tickets.status",
      status: { ...status, identity: { linear: null, github: null } },
    });
  });

  it("keeps descriptions and comments out of hot frames", () => {
    const r = parseServerMessage(
      JSON.stringify({ t: "tickets.snapshot", rev: 1, board: { tickets: [detail] }, status }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.value.t === "tickets.snapshot") {
      expect(r.value.board.tickets[0]).not.toHaveProperty("description");
      expect(r.value.board.tickets[0]).not.toHaveProperty("comments");
    }
  });

  it("rejects oversize and malformed frames", () => {
    const req = (op: unknown) =>
      parseClientMessage(JSON.stringify({ t: "tickets.req", rid: "r", op })).ok;
    const comment = (body: string) => ({ kind: "comment", issueId: "i", body });
    const prepare = (mutation: unknown) => ({ kind: "prepare", viewerId: "u1", mutation });
    expect(req(prepare(comment("x".repeat(MAX_TICKET_TEXT))))).toBe(true);
    expect(req(prepare(comment("x".repeat(MAX_TICKET_TEXT + 1))))).toBe(false);
    expect(req(prepare(comment("")))).toBe(false);
    // A write always names the account the device showed.
    expect(req({ kind: "prepare", mutation: comment("x") })).toBe(false);
    expect(req({ kind: "commit", opId: OP, mutation: comment("x") })).toBe(false);
    expect(req({ kind: "commit", viewerId: "", opId: OP, mutation: comment("x") })).toBe(false);
    const keys = Array.from({ length: MAX_TICKET_WATCH + 1 }, (_, i) => `ENG-${String(i)}`);
    expect(req({ kind: "watch", keys, ttlMs: 1000 })).toBe(false);
    expect(req({ kind: "watch", keys: ["eng-1"], ttlMs: 1000 })).toBe(false);
    expect(req({ kind: "watch", keys: ["ENG-1"], ttlMs: 0 })).toBe(false);
    expect(req({ kind: "commit", opId: "not-a-uuid", mutation: mutations[0] })).toBe(false);
    expect(req({ kind: "commit", opId: OP, mutation: { kind: "merge" } })).toBe(false);
    expect(req({ kind: "prepare", mutation: { kind: "applyPlan", rows: [] } })).toBe(false);
    expect(
      req({ kind: "plan", rows: [{ key: "ENG-1", plannedStart: "2026-11-21T00:00:00Z" }] }),
    ).toBe(false);
    expect(req({ kind: "nope" })).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({ t: "tickets.req", rid: "x".repeat(65), op: { kind: "sync" } }),
      ).ok,
    ).toBe(false);
    const many = Array.from({ length: MAX_TICKETS + 1 }, () => facts);
    expect(
      parseServerMessage(
        JSON.stringify({ t: "tickets.snapshot", rev: 1, board: { tickets: many }, status }),
      ).ok,
    ).toBe(false);
    expect(
      parseServerMessage(
        JSON.stringify({
          t: "tickets.delta",
          rev: 2,
          base: 1,
          upserts: [{ ...facts, priority: 5 }],
          tombstones: [],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseServerMessage(
        JSON.stringify({
          t: "tickets.res",
          rid: "r",
          ok: false,
          refused: { code: "nope", message: "x" },
        }),
      ).ok,
    ).toBe(false);
    // A tickets request is never a server frame, nor a push a client frame.
    expect(
      parseServerMessage(JSON.stringify({ t: "tickets.req", rid: "r", op: { kind: "sync" } })).ok,
    ).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "tickets.status", status })).ok).toBe(false);
  });

  it("every pre-existing fixture still parses", () => {
    for (const m of client)
      expect(parseClientMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(true);
    for (const m of server)
      expect(parseServerMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(true);
  });
});

describe("tickets rules", () => {
  it("classifies confirmed and unconfirmed mutations", () => {
    expect([...CONFIRMED_TICKET_MUTATIONS].sort()).toEqual([
      "applyPlan",
      "comment",
      "createIssue",
      "deleteComment",
    ]);
    const move = mutations[0]!;
    expect(ticketMutationConfirmed(move, "completed")).toBe(true);
    expect(ticketMutationConfirmed(move, "canceled")).toBe(true);
    expect(ticketMutationConfirmed(move, "started")).toBe(false);
    expect(ticketMutationConfirmed(move)).toBe(false);
    const confirmed = mutations.filter((m) => m.kind !== "setState" && ticketMutationConfirmed(m));
    expect(new Set(confirmed.map((m) => m.kind))).toEqual(CONFIRMED_TICKET_MUTATIONS);
  });

  it("names the features", () => {
    expect([
      TICKETS_FEATURE,
      TICKETS_WRITES_FEATURE,
      REVIEWS_ACTIONS_FEATURE,
      REVIEWS_GUIDE2_FEATURE,
    ]).toEqual(["tickets", "tickets.writes", "reviews.actions", "reviews.guide2"]);
  });
});
