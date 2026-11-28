import { describe, expect, it } from "vitest";
import type { Attention, TicketComment, TicketPrFacts } from "@relay/protocol";
import {
  EMPTY_HANDLED,
  applyHandled,
  attentionOf,
  excerptOf,
  type AttentionInput,
  type PrAttentionInput,
  type PrThreadComment,
} from "../src/tickets/attention";

const T0 = Date.parse("2026-11-20T10:00:00Z");
const ISAAC = { id: "u-isaac", name: "Isaac Weber", avatarUrl: null };
const NOVA = { id: "u-nova", name: "Nova", avatarUrl: null };
const LINK = "https://linear.app/ecard/profiles/isaac";
const ME = {
  linearViewerId: ISAAC.id,
  linearNames: ["isaac", "Isaac Weber"],
  ghLogin: "webdevike",
};

function comment(id: string, over: Partial<TicketComment> = {}): TicketComment {
  return {
    id,
    parentId: null,
    documentContentId: null,
    quotedText: null,
    author: NOVA,
    body: `[@isaac](${LINK}) can you check?`,
    at: T0,
    editedAt: null,
    resolvedAt: null,
    resolvingUser: null,
    reactions: [],
    url: `https://linear.app/ecard/issue/ENG-1#comment-${id}`,
    ...over,
  };
}

function facts(over: Partial<TicketPrFacts> = {}): TicketPrFacts {
  return {
    repo: "ecard/relay",
    number: 12,
    title: "Board",
    url: "https://github.com/ecard/relay/pull/12",
    author: "webdevike",
    state: "open",
    draft: false,
    checks: { state: "pass", passed: 3, failed: 0, pending: 0 },
    decision: null,
    mergeState: "BLOCKED",
    headSha: "abc123",
    updatedAt: T0,
    ...over,
  };
}

function prc(id: string, over: Partial<PrThreadComment> = {}): PrThreadComment {
  return {
    id,
    rootId: id,
    kind: "conversation",
    author: "nova",
    body: "@webdevike please look",
    at: T0,
    viewerReacted: false,
    ...over,
  };
}

function pr(over: Partial<PrAttentionInput> = {}): PrAttentionInput {
  return {
    facts: facts(),
    comments: [],
    viewerIsAuthor: false,
    viewerRequested: false,
    viewerReviewedHead: false,
    relayAutoMergeDisarmed: false,
    ...over,
  };
}

function input(over: Partial<AttentionInput> = {}): AttentionInput {
  return {
    key: "ENG-1",
    closed: false,
    comments: [],
    notices: [],
    prs: [],
    me: ME,
    handled: EMPTY_HANDLED,
    ...over,
  };
}

const waitingIds = (a: Attention): string[] => a.waiting.map((w) => w.commentId);

describe("waiting: Linear", () => {
  const cases: Array<{
    name: string;
    comments: TicketComment[];
    notices?: AttentionInput["notices"];
    closed?: boolean;
    want: string[];
  }> = [
    { name: "profile link asks", comments: [comment("c1")], want: ["c1"] },
    {
      name: "profile link to another person does not",
      comments: [comment("c1", { body: "[@bo](https://linear.app/ecard/profiles/bo) hi" })],
      want: [],
    },
    {
      name: "mention notice asks without a link",
      comments: [comment("c1", { body: "thoughts?" })],
      notices: [{ type: "issueCommentMention", issueKey: "ENG-1", commentId: "c1", at: T0 }],
      want: ["c1"],
    },
    {
      name: "unrelated notice type does not",
      comments: [comment("c1", { body: "thoughts?" })],
      notices: [{ type: "issueNewComment", issueKey: "ENG-1", commentId: "c1", at: T0 }],
      want: [],
    },
    {
      name: "Isaac's own mention never waits",
      comments: [comment("c1", { author: ISAAC })],
      want: [],
    },
    { name: "closed ticket never waits", comments: [comment("c1")], closed: true, want: [] },
    {
      name: "later text reply in same thread clears",
      comments: [
        comment("c1"),
        comment("r1", { parentId: "c1", author: ISAAC, body: "done", at: T0 + 1 }),
      ],
      want: [],
    },
    {
      name: "later emoji-only reply clears",
      comments: [
        comment("c1"),
        comment("r1", { parentId: "c1", author: ISAAC, body: "👍", at: T0 + 1 }),
      ],
      want: [],
    },
    {
      name: "earlier reply does not clear",
      comments: [
        comment("r0", { parentId: "c0", author: ISAAC, body: "ok", at: T0 - 1 }),
        comment("c2", { parentId: "c0" }),
      ],
      want: ["c2"],
    },
    {
      name: "mention inside a reply is cleared by a later reply to the root",
      comments: [
        comment("c0", { body: "start" }),
        comment("c2", { parentId: "c0", at: T0 + 1 }),
        comment("r1", { parentId: "c0", author: ISAAC, body: "yes", at: T0 + 2 }),
      ],
      want: [],
    },
    {
      name: "text reply in another thread does not clear",
      comments: [comment("c1"), comment("x1", { author: ISAAC, body: "elsewhere", at: T0 + 5 })],
      want: ["c1"],
    },
    {
      name: "Isaac's reaction clears",
      comments: [comment("c1", { reactions: [{ emoji: "👀", users: [ISAAC] }] })],
      want: [],
    },
    {
      name: "someone else's reaction does not",
      comments: [comment("c1", { reactions: [{ emoji: "👀", users: [NOVA] }] })],
      want: ["c1"],
    },
    {
      name: "resolved thread clears",
      comments: [comment("c1", { resolvedAt: T0 + 1, resolvingUser: NOVA })],
      want: [],
    },
    {
      name: "link inside a fenced block never waits",
      comments: [comment("c1", { body: `look\n\`\`\`\n${LINK}\n\`\`\`` })],
      want: [],
    },
  ];
  it.each(cases)("$name", ({ comments, notices, closed, want }) => {
    expect(
      waitingIds(attentionOf(input({ comments, notices: notices ?? [], closed: closed ?? false }))),
    ).toEqual(want);
  });

  it("collapses an item to its newest mention with a count", () => {
    const a = attentionOf(input({ comments: [comment("c1"), comment("c2", { at: T0 + 10 })] }));
    expect(a.waiting).toHaveLength(1);
    expect(a.waiting[0]).toMatchObject({
      provider: "linear",
      itemId: "ENG-1",
      commentId: "c2",
      rootId: "c2",
      count: 2,
      author: NOVA,
      anchor: { kind: "comment" },
    });
    expect(a.waiting[0]?.excerpt).toBe("can you check?");
  });

  it("anchors an inline comment on its root's quote", () => {
    const root = comment("c0", {
      body: "hm",
      documentContentId: "doc1",
      quotedText: "ship by Friday",
    });
    const reply = comment("c1", { parentId: "c0", at: T0 + 1 });
    expect(attentionOf(input({ comments: [root, reply] })).waiting[0]).toMatchObject({
      commentId: "c1",
      rootId: "c0",
      anchor: { kind: "inline", documentContentId: "doc1", quotedText: "ship by Friday" },
    });
  });
});

describe("waiting: GitHub", () => {
  const cases: Array<{
    name: string;
    comments: PrThreadComment[];
    state?: TicketPrFacts["state"];
    want: string[];
  }> = [
    { name: "@login asks", comments: [prc("g1")], want: ["g1"] },
    {
      name: "@login is case-insensitive",
      comments: [prc("g1", { body: "@WebDevIke ?" })],
      want: ["g1"],
    },
    {
      name: "@login prefix of a longer login does not",
      comments: [prc("g1", { body: "@webdevike-bot ?" })],
      want: [],
    },
    {
      name: "email-like text does not",
      comments: [prc("g1", { body: "mail me@webdevike" })],
      want: [],
    },
    {
      name: "@login in inline code never waits",
      comments: [prc("g1", { body: "run `@webdevike` now" })],
      want: [],
    },
    {
      name: "@login in a fenced block never waits",
      comments: [prc("g1", { body: "```\n@webdevike\n```\nthanks" })],
      want: [],
    },
    {
      name: "Isaac's own @mention never waits",
      comments: [prc("g1", { author: "WebDevIke" })],
      want: [],
    },
    {
      name: "later emoji-only reply in thread clears",
      comments: [
        prc("g1"),
        prc("g2", { rootId: "g1", author: "webdevike", body: "🚀", at: T0 + 1 }),
      ],
      want: [],
    },
    {
      name: "reply in another thread does not clear",
      comments: [prc("g1"), prc("g2", { author: "webdevike", body: "ok", at: T0 + 1 })],
      want: ["g1"],
    },
    { name: "viewer reaction clears", comments: [prc("g1", { viewerReacted: true })], want: [] },
    {
      name: "resolved thread clears",
      comments: [
        prc("g1", { kind: "review-line", path: "a.ts", line: 3, side: "RIGHT", resolved: true }),
      ],
      want: [],
    },
    { name: "merged PR never waits", comments: [prc("g1")], state: "merged", want: [] },
  ];
  it.each(cases)("$name", ({ comments, state, want }) => {
    expect(
      waitingIds(
        attentionOf(input({ prs: [pr({ comments, facts: facts({ state: state ?? "open" }) })] })),
      ),
    ).toEqual(want);
  });

  it("anchors a review-line reply on its root's line", () => {
    const root = prc("g1", {
      kind: "review-line",
      path: "src/a.ts",
      line: 40,
      side: "LEFT",
      body: "hm",
    });
    const reply = prc("g2", { kind: "review-line", rootId: "g1", at: T0 + 1 });
    expect(attentionOf(input({ prs: [pr({ comments: [root, reply] })] })).waiting[0]).toMatchObject(
      {
        provider: "github",
        itemId: "ecard/relay#12",
        commentId: "g2",
        rootId: "g1",
        author: { id: "nova", name: "nova" },
        anchor: {
          kind: "pr-review-line",
          pr: { repo: "ecard/relay", number: 12 },
          path: "src/a.ts",
          line: 40,
          side: "LEFT",
        },
      },
    );
  });

  it("anchors a conversation comment on the PR conversation", () => {
    expect(attentionOf(input({ prs: [pr({ comments: [prc("g1")] })] })).waiting[0]?.anchor).toEqual(
      { kind: "pr-conversation", pr: { repo: "ecard/relay", number: 12 } },
    );
  });
});

describe("mark as handled", () => {
  const target = (through: string) => ({
    kind: "mention" as const,
    provider: "linear" as const,
    itemId: "ENG-1",
    throughCommentId: through,
  });

  it("two older mentions handled, then a newer one returns alone", () => {
    const older = [comment("c1"), comment("c2", { at: T0 + 10 })];
    const before = attentionOf(input({ comments: older }));
    const handled = applyHandled(EMPTY_HANDLED, target("c2"), false, before);
    expect(handled.mentions["linear|ENG-1"]).toEqual({ commentId: "c2", at: T0 + 10 });
    expect(attentionOf(input({ comments: older, handled })).waiting).toEqual([]);
    const after = attentionOf(
      input({ comments: [...older, comment("c3", { at: T0 + 20 })], handled }),
    );
    expect(after.waiting).toHaveLength(1);
    expect(after.waiting[0]).toMatchObject({ commentId: "c3", count: 1 });
  });

  it("undo brings the mentions back", () => {
    const comments = [comment("c1")];
    const before = attentionOf(input({ comments }));
    const handled = applyHandled(EMPTY_HANDLED, target("c1"), false, before);
    const undone = applyHandled(
      handled,
      target("c1"),
      true,
      attentionOf(input({ comments, handled })),
    );
    expect(undone.mentions).toEqual({});
    expect(waitingIds(attentionOf(input({ comments, handled: undone })))).toEqual(["c1"]);
  });

  it("never moves the watermark backwards and ignores an unknown comment", () => {
    const state = {
      v: 1 as const,
      mentions: { "linear|ENG-1": { commentId: "c9", at: T0 + 100 } },
      needs: {},
    };
    const current = attentionOf(input({ comments: [comment("c1")] }));
    expect(applyHandled(state, target("c1"), false, current).mentions["linear|ENG-1"]).toEqual({
      commentId: "c1",
      at: T0 + 100,
    });
    expect(applyHandled(EMPTY_HANDLED, target("zz"), false, current)).toBe(EMPTY_HANDLED);
  });
});

describe("needs you", () => {
  const mergeable = pr({
    viewerIsAuthor: true,
    facts: facts({ decision: "APPROVED", mergeState: "CLEAN" }),
  });
  const requested = pr({ viewerRequested: true, facts: facts({ number: 13, headSha: "def456" }) });
  const disarmed = pr({
    relayAutoMergeDisarmed: true,
    facts: facts({ number: 14, headSha: "fff000" }),
  });

  const cases: Array<{
    name: string;
    over: Partial<AttentionInput>;
    want: { kind: string; text: string; evidence: string } | null;
  }> = [
    {
      name: "waiting wins",
      over: { comments: [comment("c1")], prs: [disarmed, mergeable, requested] },
      want: { kind: "waiting", text: "Waiting on your reply", evidence: "c1" },
    },
    {
      name: "auto-merge off next",
      over: { prs: [mergeable, requested, disarmed] },
      want: {
        kind: "autoMergeOff",
        text: "Auto-merge turned off: new commits since you approved",
        evidence: "fff000",
      },
    },
    {
      name: "merge next",
      over: { prs: [requested, mergeable] },
      want: { kind: "merge", text: "Merge PR #12", evidence: "abc123|APPROVED" },
    },
    {
      name: "review last",
      over: { prs: [requested] },
      want: { kind: "review", text: "Review PR #13", evidence: "def456|requested" },
    },
    {
      name: "reviewed head is not asked",
      over: { prs: [pr({ viewerRequested: true, viewerReviewedHead: true })] },
      want: null,
    },
    {
      name: "draft is not mergeable",
      over: {
        prs: [
          pr({
            viewerIsAuthor: true,
            facts: facts({ decision: "APPROVED", mergeState: "CLEAN", draft: true }),
          }),
        ],
      },
      want: null,
    },
    {
      name: "failing checks are not mergeable",
      over: {
        prs: [
          pr({
            viewerIsAuthor: true,
            facts: facts({
              decision: "APPROVED",
              mergeState: "CLEAN",
              checks: { state: "fail", passed: 1, failed: 1, pending: 0 },
            }),
          }),
        ],
      },
      want: null,
    },
    {
      name: "someone else's approved PR is not Isaac's to merge",
      over: { prs: [pr({ facts: facts({ decision: "APPROVED", mergeState: "CLEAN" }) })] },
      want: null,
    },
    { name: "nothing", over: {}, want: null },
  ];
  it.each(cases)("$name", ({ over, want }) => {
    const got = attentionOf(input(over)).needsYou;
    expect(
      got === null ? null : { kind: got.kind, text: got.text, evidence: got.evidence },
    ).toEqual(want);
  });

  it("carries the PR on PR actions", () => {
    expect(attentionOf(input({ prs: [mergeable] })).needsYou?.action).toEqual({
      kind: "merge",
      label: "Merge PR #12",
      pr: { repo: "ecard/relay", number: 12 },
    });
    expect(attentionOf(input({ comments: [comment("c1")] })).needsYou?.action).toEqual({
      kind: "reply",
      label: "Reply",
    });
  });

  it("handled evidence suppresses until new evidence, falls through to the next reason, and undo restores", () => {
    const base = input({ prs: [requested] });
    const target = {
      kind: "needs" as const,
      itemId: "ENG-1",
      reasonKind: "review" as const,
      evidence: "def456|requested",
    };
    const handled = applyHandled(EMPTY_HANDLED, target, false, attentionOf(base));
    expect(handled.needs).toEqual({ "ENG-1|review": "def456|requested" });
    expect(attentionOf({ ...base, handled }).needsYou).toBeNull();
    // Same evidence after a trivial refresh stays suppressed.
    expect(
      attentionOf({
        ...base,
        prs: [pr({ ...requested, facts: { ...requested.facts, updatedAt: T0 + 999 } })],
        handled,
      }).needsYou,
    ).toBeNull();
    // A new push is new evidence.
    expect(
      attentionOf({
        ...base,
        prs: [pr({ ...requested, facts: { ...requested.facts, headSha: "new999" } })],
        handled,
      }).needsYou?.evidence,
    ).toBe("new999|requested");
    // A suppressed higher reason lets the next one show.
    const both = input({ prs: [mergeable, requested] });
    const mergeHandled = applyHandled(
      EMPTY_HANDLED,
      { kind: "needs", itemId: "ENG-1", reasonKind: "merge", evidence: "abc123|APPROVED" },
      false,
      attentionOf(both),
    );
    expect(attentionOf({ ...both, handled: mergeHandled }).needsYou?.kind).toBe("review");
    const undone = applyHandled(handled, target, true, attentionOf({ ...base, handled }));
    expect(undone.needs).toEqual({});
    expect(attentionOf({ ...base, handled: undone }).needsYou?.kind).toBe("review");
  });

  it("waiting evidence is the newest waiting comment; a new mention returns it", () => {
    const comments = [comment("c1")];
    const handled = applyHandled(
      EMPTY_HANDLED,
      { kind: "needs", itemId: "ENG-1", reasonKind: "waiting", evidence: "c1" },
      false,
      attentionOf(input({ comments })),
    );
    expect(attentionOf(input({ comments, handled })).needsYou).toBeNull();
    expect(
      attentionOf(input({ comments: [...comments, comment("c2", { at: T0 + 1 })], handled }))
        .needsYou?.evidence,
    ).toBe("c2");
  });
});

describe("excerpt", () => {
  it("strips mentions and caps at 140 chars", () => {
    expect(excerptOf(`@webdevike  [@isaac](${LINK}) hi\nthere`)).toBe("hi there");
    const long = excerptOf("x".repeat(400));
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith("…")).toBe(true);
  });
});
