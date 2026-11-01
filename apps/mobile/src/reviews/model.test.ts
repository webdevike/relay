import { describe, expect, it } from "vitest";
import type { AstraItem, AstraTurn, LinearComment, ReviewGuide, ReviewPr, SlackMessage } from "@relay/protocol";
import {
  astraAnswer,
  composerIntent,
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
  withHostMedia,
  withPendingAsk,
  type TimelineRow,
} from "./model";

const person = (name: string) => ({ name, handle: name.toLowerCase(), url: `https://linear.app/u/${name}` });

function comment(id: string, at: number, parentId: string | null = null): LinearComment {
  return { id, parentId, author: person(id), body: id, at, url: `u/${id}`, mentionsMe: false };
}

function message(ts: string, at: number): SlackMessage {
  return { ts, author: "Todd", mine: false, text: ts, mentionsMe: false, reactions: [], files: [], at };
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
  const shape = (rows: TimelineRow<string>[]) => rows.map((row) => (row.kind === "entry" ? row.entry : row.kind === "ask" ? `ask:${row.text}` : `astra:${row.turns.map((t) => t.id).join("+")}${row.last ? "!" : ""}`));

  it("puts Astra's asks and cards among the comments by time, answers and tool work in one card", () => {
    const astra = session([
      { id: "q", role: "user", text: "@Astra why?", streaming: false, at: 200 },
      { id: "t", role: "tool", text: "read", streaming: false, at: 210 },
      { id: "r", role: "assistant", text: "because", streaming: false, at: 220 },
      { id: "q2", role: "user", text: "@Astra and?", streaming: false, at: 400 },
      { id: "r2", role: "assistant", text: "that", streaming: false, at: 410 },
    ]);
    expect(shape(mergeTimeline(entries, astra))).toEqual(["comment a", "ask:@Astra why?", "astra:t+r", "comment b", "ask:@Astra and?", "astra:r2!"]);
  });

  it("sends turns without a time to the end in session order", () => {
    const astra = session([
      { id: "q", role: "user", text: "old", streaming: false },
      { id: "r", role: "assistant", text: "older host", streaming: false, at: 50 },
    ]);
    expect(shape(mergeTimeline(entries, astra))).toEqual(["comment a", "comment b", "ask:old", "astra:r!"]);
  });

  it("never puts a card before the one ahead of it in the session", () => {
    const astra = session([
      { id: "q", role: "user", text: "late", streaming: false, at: 350 },
      { id: "r", role: "assistant", text: "clock skew", streaming: false, at: 150 },
    ]);
    expect(shape(mergeTimeline(entries, astra))).toEqual(["comment a", "comment b", "ask:late", "astra:r!"]);
  });

  it("shows a pending ask at its send time with an empty working card of Astra's after it", () => {
    const ask = pendingAsk(undefined, "@Astra what now?", 250);
    const rows = mergeTimeline(entries, withPendingAsk(undefined, "u", ask));
    expect(shape(rows)).toEqual(["comment a", "ask:@Astra what now?", "astra:!", "comment b"]);
  });

  it("adds no Astra rows without a session", () => {
    expect(shape(mergeTimeline(entries, undefined))).toEqual(["comment a", "comment b"]);
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

  it("makes next week a week on from a Monday, and the coming Monday from a Sunday", () => {
    expect(snoozeChoices(local(2026, 10, 2, 8))[2]?.until).toBe(local(2026, 10, 9, 9));
    expect(snoozeChoices(local(2026, 10, 1, 23))[2]?.until).toBe(local(2026, 10, 2, 9));
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
