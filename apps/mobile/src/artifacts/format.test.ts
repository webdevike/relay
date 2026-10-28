import { describe, expect, it } from "vitest";
import { defaultTabs, type Artifact, type ArtifactTab } from "@relay/protocol";
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
  videoLength,
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
