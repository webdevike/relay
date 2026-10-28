import { describe, expect, it } from "vitest";
import { defaultTabs, type AgentSession, type Artifact, type ArtifactTab } from "@relay/protocol";
import {
  countLabel,
  groupRows,
  hasNewArtifacts,
  hostUrl,
  initialTab,
  linkedLine,
  makerLine,
  mediaTiles,
  metaLine,
  moveIndex,
  repoName,
  rowKey,
  ruleChips,
  searchArtifacts,
  stateLabel,
  statusPills,
  subagentLine,
  subagentRows,
  taskGroups,
  taskTime,
  videoLength,
  type TaskInputs,
} from "./format";

const NOW = new Date(2026, 9, 27, 22, 53).getTime();
const at = (h: number, m: number) => new Date(2026, 9, 27, h, m).getTime();

function item(over: Partial<Artifact> & Pick<Artifact, "id" | "kind">): Artifact {
  return { title: over.id, mentions: 1, firstSeen: at(9, 0), lastSeen: at(21, 47), sources: [], addedBy: "extractor", ...over };
}

const agentTab: ArtifactTab = { id: "open-prs", title: "Open PRs", createdBy: "astra", createdAt: at(22, 41), rule: { kind: ["gh-pr"], state: ["open"] }, hidden: false, fresh: true };

describe("meta and keys", () => {
  it("writes mentions and the last time short", () => {
    expect(metaLine(item({ id: "linear:ENG-1", kind: "linear", mentions: 82 }), NOW)).toBe("82x, last 9:47 PM");
    expect(metaLine(item({ id: "linear:ENG-1", kind: "linear" }), NOW)).toBe("last 9:47 PM");
    expect(metaLine(item({ id: "u", kind: "url", lastSeen: new Date(2026, 9, 27, 0, 5).getTime() }), NOW)).toBe("last 12:05 AM");
  });

  it("names a row by its key", () => {
    expect(rowKey(item({ id: "linear:ENG-6528", kind: "linear" }))).toBe("ENG-6528");
    expect(rowKey(item({ id: "gh-pr:eCardSystems/reports-app#238", kind: "gh-pr" }))).toBe("#238");
    expect(repoName(item({ id: "gh-pr:eCardSystems/reports-app#238", kind: "gh-pr" }))).toBe("reports-app");
    expect(repoName(item({ id: "url:x", kind: "url" }))).toBeNull();
    expect(rowKey(item({ id: "url:https://x.com", kind: "url" }))).toBeNull();
  });

  it("writes Linear states as Linear does", () => {
    expect(stateLabel("in qa")).toBe("In QA");
    expect(stateLabel("in progress")).toBe("In Progress");
  });
});

describe("status pills", () => {
  it("colors a ticket by its category", () => {
    expect(statusPills(item({ id: "linear:A-1", kind: "linear", status: { state: "in progress", stateType: "started", fetchedAt: 0 } }))).toEqual([{ label: "In Progress", tone: "warn" }]);
    expect(statusPills(item({ id: "linear:A-1", kind: "linear", status: { state: "in qa", stateType: "started", fetchedAt: 0 } }))).toEqual([{ label: "In QA", tone: "accent" }]);
    expect(statusPills(item({ id: "linear:A-1", kind: "linear", status: { state: "done", stateType: "completed", fetchedAt: 0 } }))[0]?.tone).toBe("ok");
  });

  it("shows a PR's state, review and checks", () => {
    const pr = item({ id: "gh-pr:o/r#1", kind: "gh-pr", status: { state: "open", draft: true, checks: "fail", fetchedAt: 0 } });
    expect(statusPills(pr)).toEqual([
      { label: "Draft", tone: "textMuted" },
      { label: "Checks failing", tone: "danger" },
    ]);
    expect(statusPills(item({ id: "gh-pr:o/r#2", kind: "gh-pr", status: { state: "open", review: "changes", fetchedAt: 0 } }))[1]).toEqual({ label: "Changes requested", tone: "warn" });
    expect(statusPills(item({ id: "gh-pr:o/r#3", kind: "gh-pr", status: { state: "merged", checks: "fail", fetchedAt: 0 } }))).toEqual([{ label: "Merged", tone: "handoff" }]);
  });

  it("shows the linked ticket's state when the thread holds it", () => {
    const ticket = item({ id: "linear:ENG-6525", kind: "linear", status: { state: "in progress", fetchedAt: 0 } });
    const pr = item({ id: "gh-pr:o/r#241", kind: "gh-pr", status: { state: "open", linked: "ENG-6525", fetchedAt: 0 } });
    expect(linkedLine(pr, [ticket, pr])).toBe("ENG-6525 In Progress");
    expect(linkedLine(pr, [pr])).toBe("ENG-6525");
    expect(linkedLine(ticket, [ticket])).toBeNull();
  });
});

describe("groups", () => {
  const links = defaultTabs().find((tab) => tab.id === "links");
  it("puts pins first, then families in order", () => {
    if (links === undefined) throw new Error("no links tab");
    const rows = [item({ id: "url:a", kind: "url" }), item({ id: "gh-pr:o/r#1", kind: "gh-pr", pinned: { by: "astra", at: 1 } }), item({ id: "linear:A-1", kind: "linear" })];
    expect(groupRows(links, rows).map((group) => [group.title, group.items.map((row) => row.id)])).toEqual([
      ["Pinned", ["gh-pr:o/r#1"]],
      ["Linear", ["linear:A-1"]],
      ["Web", ["url:a"]],
    ]);
  });

  it("heads an agent tab with its count", () => {
    expect(groupRows(agentTab, [item({ id: "gh-pr:o/r#1", kind: "gh-pr" })]).map((group) => group.title)).toEqual(["1 open"]);
    expect(countLabel({ ...agentTab, rule: { kind: ["gh-pr"] } }, 1)).toBe("1 item");
  });

  it("nests subagents under their parent", () => {
    const sub = (id: string, parent?: string) => item({ id, kind: "subagent", subagent: { state: "running", startedAt: 0, ...(parent === undefined ? {} : { parent }) } });
    const rows = [sub("subagent:b", "subagent:a"), sub("subagent:a"), sub("subagent:c"), sub("subagent:d", "subagent:gone")];
    expect(subagentRows(rows).map((row) => [row.item.id, row.depth])).toEqual([
      ["subagent:a", 0],
      ["subagent:b", 1],
      ["subagent:c", 0],
      ["subagent:d", 0],
    ]);
  });

  it("says what a subagent does, else how it ended", () => {
    expect(subagentLine(item({ id: "s", kind: "subagent", subagent: { state: "running", line: "Reading files", startedAt: 0 } }), NOW)).toBe("Reading files");
    expect(subagentLine(item({ id: "s", kind: "subagent", subagent: { state: "failed", startedAt: 0, endedAt: at(21, 5) } }), NOW)).toBe("failed 9:05 PM");
  });
});

describe("media", () => {
  const video = item({ id: "drop:v", kind: "drop", firstSeen: 3, media: { mimeType: "video/mp4", durationMs: 11_400 }, from: "user" });
  const image = item({ id: "image:i", kind: "image", firstSeen: 5, media: { mimeType: "image/png" } });
  it("sorts newest first", () => {
    expect(mediaTiles([video, image]).map((tile) => tile.id)).toEqual(["image:i", "drop:v"]);
  });
  it("shows a video's length", () => {
    expect(videoLength(video)).toBe("0:11");
    expect(videoLength(image)).toBeNull();
  });
  it("puts host paths on the host", () => {
    expect(hostUrl("/drops/a/b", "http://h:7817")).toBe("http://h:7817/drops/a/b");
    expect(hostUrl("/drops/a/b", null)).toBeNull();
    expect(hostUrl("https://x.com", null)).toBe("https://x.com");
    expect(hostUrl(undefined, "http://h")).toBeNull();
  });
});

describe("tabs", () => {
  it("writes the rule as chips and who made it", () => {
    expect(ruleChips(agentTab.rule)).toEqual(["GitHub PR", "open"]);
    expect(makerLine(agentTab, (id) => (id === "astra" ? "Astra" : id), NOW)).toBe("Added by Astra at 10:41 PM");
  });

  it("moves past hidden tabs", () => {
    const tabs = [...defaultTabs(), agentTab];
    const hidden = tabs.map((tab) => (tab.id === "media" ? { ...tab, hidden: true } : tab));
    expect(moveIndex(hidden, "links", 1)).toBe(3);
    expect(moveIndex(hidden, "links", -1)).toBe(0);
    expect(moveIndex(hidden, "subagents", -1)).toBeNull();
    expect(moveIndex(hidden, "open-prs", 1)).toBeNull();
  });

  it("opens on the last tab, else the first with rows", () => {
    const tabs = defaultTabs();
    expect(initialTab(tabs, { links: 3 }, null)).toBe("links");
    expect(initialTab(tabs, { links: 3 }, "media")).toBe("media");
    expect(initialTab(tabs, {}, "gone")).toBe("subagents");
    expect(initialTab([], {}, null)).toBeNull();
  });

  it("searches every item, faded ones too", () => {
    const rows = [item({ id: "linear:ENG-1", kind: "linear", title: "Merchant selector", lastSeen: 1 }), item({ id: "url:x", kind: "url", title: "Other", caption: "merchant docs", lastSeen: 2 })];
    expect(searchArtifacts(rows, "merchant").map((row) => row.id)).toEqual(["url:x", "linear:ENG-1"]);
    expect(searchArtifacts(rows, "  ")).toEqual([]);
  });
});

describe("blue dot", () => {
  const items = [item({ id: "url:a", kind: "url", firstSeen: 100 })];
  it("lights for items that arrived since the last open", () => {
    expect(hasNewArtifacts(items, defaultTabs(), 50)).toBe(true);
    expect(hasNewArtifacts(items, defaultTabs(), 100)).toBe(false);
  });
  it("lights before the first open only when something is there", () => {
    expect(hasNewArtifacts(items, defaultTabs(), null)).toBe(true);
    expect(hasNewArtifacts([], defaultTabs(), null)).toBe(false);
  });
  it("lights for an agent's unopened tab, unless hidden", () => {
    expect(hasNewArtifacts([], [agentTab], 200)).toBe(true);
    expect(hasNewArtifacts([], [{ ...agentTab, hidden: true }], 200)).toBe(false);
  });
});

describe("task groups", () => {
  const sub = (name: string, state: "running" | "done" | "failed", over: Partial<Artifact> = {}): Artifact =>
    item({ id: `subagent:/s/thread/${name}.jsonl`, kind: "subagent", title: name, path: `/s/thread/${name}.jsonl`, subagent: { state, startedAt: at(22, 40), ...(state === "running" ? {} : { endedAt: at(21, 0) }) }, ...over });
  const session = (id: string, over: Partial<AgentSession> = {}): AgentSession => ({
    id,
    provider: "omp",
    title: id,
    projectPath: "/p",
    status: "working",
    lastActivity: "",
    lastActivityAt: at(22, 50),
    canRespond: true,
    ...over,
  });
  const input = (over: Partial<TaskInputs>): TaskInputs => ({ items: [], now: NOW, threadSession: "S", sessions: {}, ask: undefined, approval: undefined, agent: undefined, agentTitle: "Nova", ...over });
  const pr = (n: number, status: Partial<NonNullable<Artifact["status"]>>) =>
    item({ id: `gh-pr:ike/relay#${String(n)}`, kind: "gh-pr", title: `PR ${String(n)}`, url: `https://github.com/ike/relay/pull/${String(n)}`, status: { state: "open", fetchedAt: 0, ...status } });

  it("draws no group without rows", () => {
    expect(taskGroups(input({}))).toEqual([]);
  });

  it("orders Needs input, Ready for review, Working, Resolved", () => {
    const groups = taskGroups(
      input({
        items: [sub("a", "running"), sub("b", "done"), pr(1, {})],
        ask: { id: "q", questions: [{ id: "1", question: "Ship it?", options: [{ label: "Yes" }] }] },
      }),
    );
    expect(groups.map((group) => [group.id, group.title, group.rows.length])).toEqual([
      ["needs", "Needs input", 1],
      ["review", "Ready for review", 1],
      ["working", "Working", 1],
      ["resolved", "Resolved", 1],
    ]);
  });

  it("asks first, then approvals, then a waiting session, then the registry", () => {
    const ask = { id: "q", questions: [{ id: "1", question: "Which branch?", options: [{ label: "main" }] }] };
    const approval = { id: "t", toolName: "bash", command: "git push", requiresBiometric: false };
    const needs = (over: Partial<TaskInputs>) => taskGroups(input(over))[0]?.rows[0];
    expect(needs({ ask, approval })).toMatchObject({ state: "ask", title: "Nova asked you", line: "Which branch?", open: { kind: "close" } });
    expect(needs({ approval })).toMatchObject({ state: "approval", title: "Approve bash", line: "git push" });
    expect(needs({ sessions: { S: session("S", { status: "needs_permission", statusDetail: "edit", lastActivity: "Editing" }) } })).toMatchObject({ state: "waiting", line: "edit", at: at(22, 50), timeStyle: "clock" });
    expect(needs({ sessions: { S: session("S", { status: "waiting", lastActivity: "Asked about tests" }) } })).toMatchObject({ line: "Asked about tests" });
    expect(needs({ agent: { id: "nova", title: "Nova", status: "needs_you", lastReply: { text: "Pick one", at: at(22, 1) } } })).toMatchObject({ title: "Nova needs you", line: "Pick one" });
    expect(needs({ agent: { id: "nova", title: "Nova", status: "idle" } })).toBeUndefined();
  });

  it("lists open PRs, drafts too, with their review and checks", () => {
    const rows = taskGroups(
      input({
        items: [
          pr(1, { draft: true, checks: "pending" }),
          pr(2, { review: "required", checks: "pass" }),
          pr(3, { review: "changes", checks: "fail" }),
          pr(4, { review: "approved" }),
          pr(5, {}),
          pr(6, { state: "merged" }),
          item({ id: "gh-pr:ike/relay#7", kind: "gh-pr", status: { state: "open", fetchedAt: 0 }, lastSeen: at(9, 0) - 8 * 24 * 3600 * 1000 }),
        ],
      }),
    )[0]?.rows;
    expect(rows?.map((row) => row.line)).toEqual([
      "Draft · Checks running · relay #1",
      "Review requested · Checks pass · relay #2",
      "Changes requested · Checks failing · relay #3",
      "Approved · relay #4",
      "Open · relay #5",
    ]);
    expect(rows?.map((row) => row.tone)).toEqual(["textMuted", "accent", "danger", "accent", "accent"]);
    expect(rows?.[0]?.open).toEqual({ kind: "url", url: "https://github.com/ike/relay/pull/1" });
  });

  it("nests running subagents and reads the live mirror's status", () => {
    const parent = sub("Lead", "running", { subagent: { state: "running", startedAt: at(22, 40), line: "Planning" } });
    const child = sub("Lead.Scout", "running", { title: "Scout", subagent: { state: "running", parent: parent.id, startedAt: at(22, 45) } });
    const sessions = { "S:Lead": session("S:Lead", { parentId: "S", statusDetail: "Reading format.ts" }), "X:Lead.Scout": session("X:Lead.Scout", { parentId: "X" }) };
    const rows = taskGroups(input({ items: [child, parent], sessions }))[0]?.rows;
    expect(rows?.map((row) => [row.title, row.depth, row.line, row.timeStyle])).toEqual([
      ["Lead", 0, "Reading format.ts", "elapsed"],
      ["Scout", 1, "started 10:45 PM", "elapsed"],
    ]);
    expect(rows?.[0]?.open).toEqual({ kind: "session", sessionId: "S:Lead" });
    expect(rows?.[1]?.open).toBeNull();
    expect(rows?.[0] === undefined ? null : taskTime(rows[0], NOW)).toBe("13m 0s");
  });

  it("folds finished subagents newest first, failures led by Failed", () => {
    const done = sub("Old", "done", { subagent: { state: "done", startedAt: at(20, 0), endedAt: at(20, 30) } });
    const failed = sub("New", "failed", { subagent: { state: "failed", startedAt: at(21, 0), endedAt: at(21, 30) } });
    const yesterday = sub("Gone", "done", { subagent: { state: "done", startedAt: 0, endedAt: at(9, 0) - 24 * 3600 * 1000 } });
    const sessions = { "S:New": session("S:New", { parentId: "S", status: "ended", lastActivity: "Tests broke" }) };
    const rows = taskGroups(input({ items: [done, failed, yesterday], sessions }))[0]?.rows;
    expect(rows?.map((row) => [row.title, row.state, row.line, row.tone])).toEqual([
      ["New", "failed", "Failed · Tests broke", "danger"],
      ["Old", "done", "Done", "ok"],
    ]);
    expect(rows?.[1] === undefined ? null : taskTime(rows[1], NOW)).toBe("8:30 PM");
  });
});
