import { describe, expect, it } from "vitest";
import type { AstraItem, AstraTurn, LinearComment, ReviewGuide, ReviewPr, SlackMessage } from "@relay/protocol";
import {
  astraAnswer,
  composerIntent,
  githubMarkdown,
  githubPrOf,
  guideProgress,
  insertMention,
  linearEntries,
  linearThreads,
  mentionCandidates,
  mentionQuery,
  mergeTimeline,
  pendingAsk,
  prBadge,
  prEntries,
  slackEntries,
  slackParts,
  snoozeChoices,
  splitDiffFiles,
  splitPath,
  linearMentions,
  withHostMedia,
  withPendingAsk,
  type ThreadPart,
  type TimelineRow,
  astraThreads,
  astraTyping,
  reviewItemRoute,
  stripThreadReply,
  threadReplyText,
  threadSnippet,
} from "./model";

const person = (name: string) => ({ name, handle: name.toLowerCase(), url: `https://linear.app/u/${name}` });

function comment(id: string, at: number, parentId: string | null = null): LinearComment {
  return { id, parentId, author: person(id), body: id, at, url: `u/${id}`, mentionsMe: false };
}

function message(ts: string, at: number): SlackMessage {
  return { ts, author: "Todd", mine: false, text: ts, mentionsMe: false, reactions: [], files: [], attachments: [], at };
}

describe("composerIntent", () => {
  const github = { kind: "github", repo: "eCardSystems/api", number: 170 } as const;

  it("makes an @Astra mention a private ask and never a post", () => {
    expect(composerIntent("  @Astra what's risky here? ", github)).toEqual({ kind: "astra", text: "@Astra what's risky here?" });
    expect(composerIntent("hey @astra.", github)?.kind).toBe("astra");
    expect(composerIntent("mail me at foo@astra.dev", github)?.kind).toBe("post");
  });

  it("ignores blank text", () => {
    expect(composerIntent("   ", github)).toBeNull();
  });

  it("names where each post lands", () => {
    expect(composerIntent("LGTM", github)).toMatchObject({
      op: { kind: "comment", repo: "eCardSystems/api", number: 170, body: "LGTM" },
      destination: "Post to GitHub eCardSystems/api#170",
    });
    const linear = { kind: "linear", issueId: "uuid", key: "ENG-6406", reply: null } as const;
    expect(composerIntent("Ship it", linear)).toMatchObject({ op: { kind: "linearComment", issueId: "uuid", parentId: null }, destination: "Post to Linear ENG-6406" });
    expect(composerIntent("Ship it", { ...linear, reply: { parentId: "c1", name: "Steve Arms" } })).toMatchObject({
      op: { parentId: "c1" },
      destination: "Reply to Steve Arms on Linear ENG-6406",
    });
    expect(composerIntent("Yes", { kind: "slack", channel: "C1", threadTs: "1.2", channelName: "#ui-ux" })).toMatchObject({
      op: { kind: "slackSend", channel: "C1", threadTs: "1.2", text: "Yes" },
      destination: "Hand to Astra to send in Slack #ui-ux",
    });
  });
});

describe("splitDiffFiles", () => {
  it("cuts gh pr diff into one patch per file from its first hunk", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "diff --git a/img.png b/img.png",
      "Binary files differ",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    const files = splitDiffFiles(diff);
    expect([...files.keys()]).toEqual(["src/a.ts", "gone.ts"]);
    expect(files.get("src/a.ts")).toBe("@@ -1,2 +1,2 @@\n-old\n+new");
    expect(files.get("gone.ts")).toBe("@@ -1 +0,0 @@\n-bye");
  });

  it("splits a path into folder and name", () => {
    expect(splitPath("src/assets/a.ts")).toEqual({ dir: "src/assets/", name: "a.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("linearThreads", () => {
  it("puts replies under their top-level comment, oldest first", () => {
    const threads = linearThreads([comment("r2", 4, "a"), comment("b", 3), comment("a", 1), comment("r1", 2, "a")]);
    expect(threads.map((t) => [t.comment.id, t.replies.map((r) => r.id)])).toEqual([
      ["a", ["r1", "r2"]],
      ["b", []],
    ]);
  });

  it("shows a reply whose parent is missing on its own", () => {
    expect(linearThreads([comment("orphan", 1, "gone")]).map((t) => t.comment.id)).toEqual(["orphan"]);
  });
});

describe("withHostMedia", () => {
  it("points Linear uploads at the host", () => {
    expect(withHostMedia("![shot](/reviews/media/x.png) and <img src=\"/reviews/media/y.png\">", "http://mac:8"))
      .toBe("![shot](http://mac:8/reviews/media/x.png) and <img src=\"http://mac:8/reviews/media/y.png\">");
    expect(withHostMedia("![a](/reviews/media/x.png)", null)).toBe("![a](/reviews/media/x.png)");
  });
});

describe("slackParts", () => {
  it("makes a thread's first message its parent; a DM has none", () => {
    const messages = [message("2", 2), message("1", 1), message("3", 3)];
    const thread = slackParts(messages, "1");
    expect(thread.parent?.ts).toBe("1");
    expect(thread.replies.map((m) => m.ts)).toEqual(["2", "3"]);
    expect(slackParts(messages, null).parent).toBeNull();
  });
});

describe("guide and badges", () => {
  it("counts ticked files of the Guide only", () => {
    const guide: ReviewGuide = { headSha: "h", source: "model", error: null, sections: [{ title: "", why: "", files: ["a", "b"] }, { title: "", why: "", files: ["c"] }] };
    expect(guideProgress(guide, ["a", "c", "stale"])).toEqual({ done: 2, total: 3 });
  });

  it("labels a PR's state", () => {
    expect(prBadge({ state: "OPEN", draft: false }).label).toBe("Open");
    expect(prBadge({ state: "OPEN", draft: true }).label).toBe("Draft");
    expect(prBadge({ state: "MERGED", draft: false }).label).toBe("Merged");
  });

  it("finds a card's answer for Use as reply", () => {
    const turns: AstraTurn[] = [
      { id: "2", role: "assistant", text: " first ", streaming: false },
      { id: "3", role: "tool", text: "read", streaming: false },
      { id: "4", role: "assistant", text: "second", streaming: false },
    ];
    expect(astraAnswer(turns)).toBe("second");
    expect(astraAnswer([{ id: "t", role: "tool", text: "read", streaming: false }])).toBeNull();
  });
});

describe("githubPrOf", () => {
  it("reads a linked PR's repo and number", () => {
    expect(githubPrOf("https://github.com/eCardSystems/api/pull/243#issuecomment-1")).toEqual({ repo: "eCardSystems/api", number: 243 });
    expect(githubPrOf("https://github.com/eCardSystems/api/issues/243")).toBeNull();
  });
});

describe("native emoji in the composer", () => {
  it("go out exactly as typed to Slack, GitHub and Linear", () => {
    const text = "Ship it 🎬👍🏽 ✅ 👨‍👩‍👧";
    expect(composerIntent(`  ${text}\n`, { kind: "slack", channel: "C1", threadTs: null, channelName: "Chris" })).toMatchObject({ op: { kind: "slackSend", text } });
    expect(composerIntent(text, { kind: "github", repo: "o/r", number: 1 })).toMatchObject({ op: { kind: "comment", body: text } });
    expect(composerIntent(text, { kind: "linear", issueId: "i", key: "ENG-1", reply: null })).toMatchObject({ op: { kind: "linearComment", body: text } });
  });
});

describe("mergeTimeline", () => {
  const session = (turns: AstraTurn[], extra: Partial<AstraItem> = {}): AstraItem => ({ url: "u", title: "t", sessionId: "s", turns, working: false, waiting: null, error: null, ...extra });
  const entries = [
    { key: "a", at: 100, entry: "comment a" },
    { key: "b", at: 300, entry: "comment b" },
  ];
  const part = (p: ThreadPart) => (p.kind === "ask" ? `ask:${p.text}` : `astra:${p.turns.map((t) => t.id).join("+")}`);
  const shape = (rows: TimelineRow<string>[]) =>
    rows.map((row) => (row.kind === "entry" ? row.entry : `${row.thread.root?.text ?? "-"}${row.thread.live ? "!" : ""}[${row.thread.replies.map(part).join(", ")}]`));

  it("puts each thread among the comments at its root's time, her answers and tool work in one reply", () => {
    const astra = session([
      { id: "q", role: "user", text: "@Astra why?", streaming: false, at: 200 },
      { id: "t", role: "tool", text: "read", streaming: false, at: 210 },
      { id: "r", role: "assistant", text: "because", streaming: false, at: 220 },
      { id: "q2", role: "user", text: "@Astra and?", streaming: false, at: 400 },
      { id: "r2", role: "assistant", text: "that", streaming: false, at: 410 },
    ]);
    expect(shape(mergeTimeline(entries, astra))).toEqual(["comment a", "@Astra why?[astra:t+r]", "comment b", "@Astra and?![astra:r2]"]);
  });

  it("sends turns without a time to the end in session order", () => {
    const astra = session([
      { id: "q", role: "user", text: "old", streaming: false },
      { id: "r", role: "assistant", text: "older host", streaming: false, at: 50 },
    ]);
    expect(shape(mergeTimeline(entries, astra))).toEqual(["comment a", "comment b", "old![astra:r]"]);
  });

  it("never puts a thread before the one ahead of it in the session", () => {
    const astra = session([
      { id: "q", role: "user", text: "late", streaming: false, at: 350 },
      { id: "q2", role: "user", text: "skewed", streaming: false, at: 150 },
    ]);
    expect(shape(mergeTimeline(entries, astra))).toEqual(["comment a", "comment b", "late[]", "skewed![]"]);
  });

  it("shows a pending ask at once as a new thread with an empty reply of hers", () => {
    const ask = pendingAsk(undefined, "@Astra what now?", 250);
    const rows = mergeTimeline(entries, withPendingAsk(undefined, "u", ask));
    expect(shape(rows)).toEqual(["comment a", "@Astra what now?![astra:]", "comment b"]);
    expect(rows[1]?.kind === "thread" && rows[1].thread.replies[0]?.id).toBe("pending-ask-pending");
  });

  it("adds no Astra rows without a session", () => {
    expect(shape(mergeTimeline(entries, undefined))).toEqual(["comment a", "comment b"]);
  });
});

describe("Astra threads", () => {
  const user = (id: string, text: string, at: number): AstraTurn => ({ id, role: "user", text, streaming: false, at });
  const her = (id: string, text: string, at: number, streaming = false): AstraTurn => ({ id, role: "assistant", text, streaming, at });

  it("makes the snippet and the reply prefix exactly as the desktop does", () => {
    expect(threadSnippet('  @Astra is "this"\n\tsafe?  ')).toBe("@Astra is 'this' safe?");
    expect(threadSnippet("x".repeat(100))).toHaveLength(80);
    expect(threadReplyText('@Astra is "this" safe?', "  and the tests? ")).toBe(`(Reply in your thread on "@Astra is 'this' safe?")\nand the tests?`);
    expect(stripThreadReply(threadReplyText("root", "words"))).toBe("words");
    expect(stripThreadReply("no prefix")).toBe("no prefix");
  });

  it("starts a thread for each main-composer ask and routes a reply to the thread it names", () => {
    const threads = astraThreads(
      [
        user("a", "@Astra first?", 1),
        her("a1", "one", 2),
        user("b", "@Astra second?", 3),
        her("b1", "two", 4),
        user("c", threadReplyText("@Astra first?", "more on one"), 5),
        her("c1", "one, more", 6),
      ],
      false,
    );
    expect(threads.map((t) => [t.root?.text, t.live, t.replies.map((p) => (p.kind === "ask" ? `ask:${p.text}` : `astra:${p.turns.map((x) => x.id).join("+")}`))])).toEqual([
      ["@Astra first?", true, ["astra:a1", "ask:more on one", "astra:c1"]],
      ["@Astra second?", false, ["astra:b1"]],
    ]);
  });

  it("sends a reply naming no thread to the newest one, and with no thread makes it a root without its prefix", () => {
    const orphan = threadReplyText("gone", "hello");
    expect(astraThreads([user("a", "@Astra hi", 1), user("b", orphan, 2)], false)[0]?.replies).toEqual([{ kind: "ask", id: "b", at: 2, text: "hello" }]);
    expect(astraThreads([user("b", orphan, 2)], false).map((t) => t.root?.text)).toEqual(["hello"]);
  });

  it("gives the thread of the newest ask an empty reply of hers while pending", () => {
    const turns = [user("a", "@Astra first?", 1), her("a1", "one", 2), user("b", "@Astra second?", 3), user("c", threadReplyText("@Astra first?", "and?"), 4)];
    const [first, second] = astraThreads(turns, true);
    expect(first?.live).toBe(true);
    expect(first?.replies.at(-1)).toEqual({ kind: "reply", id: "c-pending", at: 4, turns: [] });
    expect(second?.replies).toEqual([]);
    expect(astraThreads(turns.slice(0, 2), true)[0]?.replies).toHaveLength(1);
  });

  it("types while she works with no answer streaming", () => {
    expect(astraTyping([], true)).toBe(true);
    expect(astraTyping([{ id: "t", role: "tool", text: "read", streaming: false }], true)).toBe(true);
    expect(astraTyping([her("r", "Look", 1, true)], true)).toBe(false);
    expect(astraTyping([her("r", "", 1, true)], true)).toBe(true);
    expect(astraTyping([], false)).toBe(false);
  });
});

describe("reviewItemRoute", () => {
  it("opens a PR, a Linear issue and a Slack permalink on their screens", () => {
    const pr = "https://github.com/eCardSystems/react-client-reports-app/pull/246";
    expect(reviewItemRoute(pr)).toEqual({ pathname: "/reviews/pr", params: { url: pr, repo: "eCardSystems/react-client-reports-app", number: "246" } });
    const linear = "https://linear.app/ecard/issue/ENG-6604/fix-the-thing";
    expect(reviewItemRoute(linear)).toEqual({ pathname: "/reviews/linear", params: { url: linear, key: "ENG-6604" } });
    expect(reviewItemRoute("https://linear.app/ecard/issue/ENG-6604")).toMatchObject({ params: { key: "ENG-6604" } });
    const message = "https://ecard.slack.com/archives/C0123ABC/p1730000000123456";
    expect(reviewItemRoute(message)).toEqual({ pathname: "/reviews/slack", params: { url: message, channel: "C0123ABC", threadTs: "1730000000.123456" } });
    const reply = `${message}?thread_ts=1729999999.000100&cid=C0123ABC`;
    expect(reviewItemRoute(reply)).toMatchObject({ params: { channel: "C0123ABC", threadTs: "1729999999.000100" } });
  });

  it("opens nothing for any other link", () => {
    expect(reviewItemRoute("https://github.com/eCardSystems/api/issues/3")).toBeNull();
    expect(reviewItemRoute("https://example.com")).toBeNull();
  });
});

describe("timeline entries", () => {
  it("makes a Linear ticket's threads and history lines dated entries", () => {
    const entries = linearEntries([comment("c1", 10), comment("r1", 30, "c1")], [{ at: 20, actor: "Steve Arms", text: "changed status from In QA to Done", highlights: ["In QA", "Done"] }]);
    expect(entries.map((e) => [e.key, e.at, e.entry.kind])).toEqual([
      ["c1", 10, "thread"],
      ["activity-0", 20, "activity"],
    ]);
  });

  it("turns a PR's pushes and bare verdicts into lines and drops a bare comment review", () => {
    const pr: Pick<ReviewPr, "author" | "body" | "createdAt" | "timeline"> = {
      author: { login: "todd" },
      body: "",
      createdAt: 1,
      timeline: [
        { kind: "commit", author: "todd", body: "fix the thing", state: "abc1234", at: 2 },
        { kind: "review", author: "isaac", body: "", state: "APPROVED", at: 3 },
        { kind: "review", author: "sam", body: "", state: "COMMENTED", at: 4 },
        { kind: "review", author: "sam", body: "Nit: rename", state: "CHANGES_REQUESTED", at: 5 },
        { kind: "comment", author: "todd", body: "Done", state: null, at: 6 },
      ],
    };
    expect(prEntries(pr).map((e) => e.entry)).toEqual([
      { kind: "post", author: "todd", body: "_No description._", verdict: null },
      { kind: "activity", actor: "todd", text: "pushed abc1234: fix the thing", highlights: ["abc1234"] },
      { kind: "activity", actor: "isaac", text: "approved these changes", highlights: [] },
      { kind: "post", author: "sam", body: "Nit: rename", verdict: "CHANGES_REQUESTED" },
      { kind: "post", author: "todd", body: "Done", verdict: null },
    ]);
  });

  it("puts the replies divider after a Slack thread's parent", () => {
    expect(slackEntries([message("2.0", 2), message("1.0", 1)], "1.0").map((e) => e.key)).toEqual(["1.0", "replies", "2.0"]);
    expect(slackEntries([message("1.0", 1)], null).map((e) => e.key)).toEqual(["1.0"]);
  });
});

describe("snoozeChoices", () => {
  const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).getTime();

  it("offers three hours on, tomorrow 9 AM and next Monday 9 AM in local time", () => {
    const now = local(2026, 9, 30, 17, 53); // Friday, October 30, 2026
    expect(snoozeChoices(now)).toEqual([
      { key: "later", label: "Later today", until: now + 3 * 3_600_000 },
      { key: "tomorrow", label: "Tomorrow", until: local(2026, 9, 31, 9) },
      { key: "next-week", label: "Next week", until: local(2026, 10, 2, 9) },
    ]);
  });

  it("makes next week a week on from a Monday, and never the same time as Tomorrow (a Sunday)", () => {
    expect(snoozeChoices(local(2026, 10, 2, 8))[2]?.until).toBe(local(2026, 10, 9, 9));
    expect(snoozeChoices(local(2026, 10, 1, 23))[1]?.until).toBe(local(2026, 10, 2, 9));
    expect(snoozeChoices(local(2026, 10, 1, 23))[2]?.until).toBe(local(2026, 10, 9, 9));
  });
});

describe("mentions", () => {
  it("reads the name being typed after a trailing @", () => {
    expect(mentionQuery("hey @")).toBe("");
    expect(mentionQuery("@ste")).toBe("ste");
    expect(mentionQuery("mail foo@bar")).toBeNull();
    expect(mentionQuery("hey @steve ")).toBeNull();
  });

  it("offers Astra first, then the item's people once each, matched at any word start", () => {
    expect(mentionCandidates(["Steve Arms", "Todd", "steve arms", "astra", ""], "")).toEqual(["Astra", "Steve Arms", "Todd"]);
    expect(mentionCandidates(["Steve Arms", "Todd"], "ar")).toEqual(["Steve Arms"]);
    expect(mentionCandidates(["Steve Arms", "Todd"], "a")).toEqual(["Astra", "Steve Arms"]);
  });

  it("replaces the typed @query with the picked name, or adds it at the end", () => {
    expect(insertMention("thanks @ste", "Steve Arms")).toBe("thanks @Steve Arms ");
    expect(insertMention("@", "Astra")).toBe("@Astra ");
    expect(insertMention("thanks", "Todd")).toBe("thanks @Todd ");
    expect(insertMention("", "Todd")).toBe("@Todd ");
  });
});

describe("githubMarkdown", () => {
  it("turns the HTML bots put in PR bodies into Markdown", () => {
    const body = '<!-- linear-review-link -->\n<p><a href="https://linear.app/x/review/1?openGuide=true">Review in Linear</a></p>\n\n## What\nLine<br>two <img src="https://x/a.png" width="300">';
    expect(githubMarkdown(body)).toBe("[Review in Linear](https://linear.app/x/review/1?openGuide=true)\n\n## What\nLine\ntwo ![](https://x/a.png)");
  });
});

describe("linearMentions", () => {
  it("shows profile links as a bold @Name, the handle when nobody matches", () => {
    const people = [{ name: "Noah Champoux", handle: "noah" }];
    expect(linearMentions("https://linear.app/ecard-systems/profiles/noah Sounds good, <https://linear.app/ws/profiles/sarms>?", people)).toBe(
      "**@Noah Champoux** Sounds good, **@sarms**?",
    );
    expect(linearMentions("[Noah](https://linear.app/ws/profiles/noah)", people)).toBe("[Noah](https://linear.app/ws/profiles/noah)");
  });
});
