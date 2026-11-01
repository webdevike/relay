import { describe, expect, it } from "vitest";
import type { AstraItem, LinearComment, ReviewGuide, SlackMessage } from "@relay/protocol";
import { composerIntent, githubPrOf, guideProgress, lastAstraAnswer, linearThreads, prBadge, slackParts, splitDiffFiles, splitPath, withHostMedia } from "./model";

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

  it("finds Astra's newest answer for Use as reply", () => {
    const item: AstraItem = {
      url: "u",
      title: "t",
      sessionId: null,
      working: false,
      waiting: null,
      error: null,
      turns: [
        { id: "1", role: "user", text: "q", streaming: false },
        { id: "2", role: "assistant", text: " first ", streaming: false },
        { id: "3", role: "tool", text: "read", streaming: false },
        { id: "4", role: "assistant", text: "second", streaming: false },
      ],
    };
    expect(lastAstraAnswer(item)).toBe("second");
    expect(lastAstraAnswer(undefined)).toBeNull();
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
