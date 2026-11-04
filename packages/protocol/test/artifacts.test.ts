import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  artifactFaded,
  defaultTabFor,
  defaultTabs,
  parseClientMessage,
  parseServerMessage,
  ruleMatches,
  sameRule,
  subagentView,
  tabItems,
  tidyIds,
  type Artifact,
  ArtifactTab,
} from "../src";

const NOW = new Date(2026, 9, 27, 21, 47).getTime();

function item(over: Partial<Artifact> & Pick<Artifact, "id" | "kind">): Artifact {
  return {
    title: over.id,
    mentions: 1,
    firstSeen: NOW - 1000,
    lastSeen: NOW - 1000,
    sources: [],
    addedBy: "extractor",
    ...over,
  };
}

const pr = item({
  id: "gh-pr:o/r#1",
  kind: "gh-pr",
  repo: "eCardSystems/react-client-reports-app",
  status: { state: "open", draft: true, fetchedAt: NOW },
});
const merged = item({
  id: "gh-pr:o/r#2",
  kind: "gh-pr",
  status: { state: "merged", fetchedAt: NOW, changedAt: NOW - 3 * DAY_MS },
});
const ticket = item({
  id: "linear:ENG-1",
  kind: "linear",
  status: { state: "in progress", stateType: "started", fetchedAt: NOW },
});
const old = item({ id: "url:https://a.dev", kind: "url", lastSeen: NOW - 8 * DAY_MS });
const pinnedOld = item({
  id: "url:https://b.dev",
  kind: "url",
  lastSeen: NOW - 30 * DAY_MS,
  pinned: { by: "astra", at: NOW - 5 },
});
const proof = item({
  id: "drop:1",
  kind: "drop",
  caption: "Before/after of the header",
  media: { mimeType: "image/png" },
});
const running = item({
  id: "subagent:/a.jsonl",
  kind: "subagent",
  lastSeen: NOW - 5 * DAY_MS,
  subagent: { state: "running", startedAt: NOW - 5 * DAY_MS },
});
const yesterday = item({
  id: "subagent:/b.jsonl",
  kind: "subagent",
  subagent: { state: "done", startedAt: NOW - DAY_MS, endedAt: NOW - DAY_MS },
});
const items = [pr, merged, ticket, old, pinnedOld, proof, running, yesterday];

describe("artifact rules", () => {
  it("matches kind, state (or Linear's category), repo by name, caption alternatives, media and pins", () => {
    expect(ruleMatches({ kind: ["gh-pr"], state: ["OPEN"] }, pr)).toBe(true);
    expect(ruleMatches({ kind: ["gh-pr"], state: ["open"] }, merged)).toBe(false);
    expect(ruleMatches({ state: ["started"] }, ticket)).toBe(true);
    expect(ruleMatches({ repo: "react-client-reports-app" }, pr)).toBe(true);
    expect(ruleMatches({ repo: "reports-app" }, pr)).toBe(false);
    expect(ruleMatches({ caption: "before|after" }, proof)).toBe(true);
    expect(ruleMatches({ media: true }, proof)).toBe(true);
    expect(ruleMatches({ pinned: true }, pinnedOld)).toBe(true);
    expect(ruleMatches({ state: ["running"] }, running)).toBe(true);
  });

  it("compares rules by meaning and names the default a rule repeats", () => {
    expect(
      sameRule(
        { kind: ["gh-pr", "linear"], state: ["Open"] },
        { state: ["open"], kind: ["linear", "gh-pr"] },
      ),
    ).toBe(true);
    expect(defaultTabFor({ kind: ["url", "linear", "gh-issue", "gh-pr", "branch"] })).toBe("links");
    expect(defaultTabFor({})).toBe("everything");
    expect(defaultTabFor({ kind: ["gh-pr"] })).toBeNull();
  });
});

describe("fading and tab contents", () => {
  it("fades stale links, merged PRs after two days, and finished subagents after their day; never pins", () => {
    expect(artifactFaded(old, NOW)).toBe(true);
    expect(artifactFaded(pinnedOld, NOW)).toBe(false);
    expect(artifactFaded(merged, NOW)).toBe(true);
    expect(artifactFaded(running, NOW)).toBe(false);
    expect(artifactFaded(yesterday, NOW)).toBe(true);
    expect(artifactFaded(pr, NOW)).toBe(false);
  });

  it("draws the default tabs, pinned first and running subagents ahead of the rest", () => {
    const [subagents, links, media, everything] = defaultTabs() as [
      ArtifactTab,
      ArtifactTab,
      ArtifactTab,
      ArtifactTab,
    ];
    expect(defaultTabs().map((tab) => tab.title)).toEqual([
      "Subagents",
      "Links",
      "Media",
      "Everything",
    ]);
    expect(tabItems(subagents, items, NOW).map((found) => found.id)).toEqual(["subagent:/a.jsonl"]);
    expect(tabItems(links, items, NOW).map((found) => found.id)).toEqual([
      "url:https://b.dev",
      "gh-pr:o/r#1",
      "linear:ENG-1",
    ]);
    expect(tabItems(media, items, NOW).map((found) => found.id)).toEqual(["drop:1"]);
    expect(tabItems(everything, items, NOW)[0]?.id).toBe("url:https://b.dev");
    expect(tabItems(everything, items, NOW)[1]?.id).toBe("subagent:/a.jsonl");
  });

  it("shows an item tab's picks in order (they never fade), pinned first, skipping unknown ids", () => {
    const tab: ArtifactTab = {
      id: "picks",
      title: "Picks",
      createdBy: "astra",
      createdAt: NOW,
      items: ["url:https://a.dev", "nope", "url:https://b.dev"],
      hidden: false,
    };
    expect(tabItems(tab, items, NOW).map((found) => found.id)).toEqual([
      "url:https://b.dev",
      "url:https://a.dev",
    ]);
  });
});

describe("tab icons", () => {
  it("reads the old robot icon as subtask, in stored tabs and in agents' actions", () => {
    expect(defaultTabs()[0]?.icon).toBe("subtask");
    expect(
      ArtifactTab.parse({
        id: "subagents",
        title: "Subagents",
        icon: "robot",
        createdBy: "default",
        createdAt: 0,
        rule: { kind: ["subagent"] },
        hidden: false,
      }).icon,
    ).toBe("subtask");
    const act = parseClientMessage(
      JSON.stringify({
        t: "artifacts.act",
        thread: "assistant:nova",
        rid: "r",
        by: "nova",
        action: {
          op: "tab.add",
          title: "Helpers",
          icon: "robot",
          rule: { kind: ["subagent"], state: ["running"] },
        },
      }),
    );
    expect(
      act.ok && act.value.t === "artifacts.act" && act.value.action.op === "tab.add"
        ? act.value.action.icon
        : null,
    ).toBe("subtask");
  });
});

describe("artifacts frames", () => {
  it("parses get, act, snapshot and acted, and rejects a bad rule", () => {
    expect(
      parseClientMessage(JSON.stringify({ t: "artifacts.get", thread: "assistant:astra" })).ok,
    ).toBe(true);
    const act = {
      t: "artifacts.act",
      thread: "session:01a1",
      rid: "r1",
      by: "astra",
      action: {
        op: "tab.add",
        title: "Open PRs",
        icon: "git-pull-request",
        rule: { kind: ["gh-pr"], state: ["open"] },
      },
    };
    expect(parseClientMessage(JSON.stringify(act))).toEqual({ ok: true, value: act });
    expect(
      parseClientMessage(
        JSON.stringify({ ...act, action: { op: "tab.add", title: "x", rule: { kind: ["nope"] } } }),
      ).ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({ ...act, action: { op: "tab.add", title: "x", rule: { colour: "red" } } }),
      ).ok,
    ).toBe(false);
    expect(
      parseServerMessage(
        JSON.stringify({
          t: "artifacts.snapshot",
          thread: "assistant:nova",
          items,
          tabs: defaultTabs(),
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseServerMessage(
        JSON.stringify({ t: "artifacts.acted", rid: "r1", ok: false, error: "Isaac hid it." }),
      ).ok,
    ).toBe(true);
  });
});

describe("subagentView and tidyIds", () => {
  const sub = (id: string, state: "running" | "done" | "failed", over: Partial<Artifact> = {}) =>
    item({
      id: `subagent:${id}`,
      kind: "subagent",
      subagent: { state, startedAt: NOW - 60_000 },
      ...over,
    });

  it("reads a running subagent nobody touched in 30 minutes as done", () => {
    expect(subagentView(sub("a", "running"), NOW)).toBe("running");
    expect(
      subagentView(
        sub("a", "running", {
          lastSeen: NOW - 31 * 60_000,
          subagent: { state: "running", startedAt: NOW - 31 * 60_000 },
        }),
        NOW,
      ),
    ).toBe("done");
    expect(subagentView(sub("a", "failed"), NOW)).toBe("failed");
    expect(subagentView(ticket, NOW)).toBeNull();
  });

  it("tidies finished, closed, stale and duplicate items and keeps running, pinned and recent ones", () => {
    const fillers = [10, 20, 30, 40, 50].map((n) => `user@${NOW - 1000 + n}`);
    const all = [
      sub("run", "running"),
      sub("done", "done"),
      sub("bad", "failed"),
      sub("pinned", "done", { pinned: { by: "isaac", at: NOW }, sources: fillers }),
      sub("fresh", "done", { sources: [`assistant@${NOW}`] }),
      item({
        id: "linear:ENG-9",
        kind: "linear",
        sources: ["user@1"],
        status: { state: "done", stateType: "completed", fetchedAt: NOW },
      }),
      item({
        id: "linear:ENG-2",
        kind: "linear",
        sources: [`user@${NOW}`],
        status: { state: "in progress", stateType: "started", fetchedAt: NOW },
      }),
      item({
        id: "url:https://a.test/x",
        kind: "url",
        url: "https://a.test/x",
        lastSeen: NOW - 2 * DAY_MS,
        sources: [`user@${NOW}`, "user@1"],
      }),
      item({
        id: "url:https://a.test/y",
        kind: "url",
        url: "https://a.test/y",
        lastSeen: NOW - 2 * DAY_MS,
        sources: ["user@2"],
      }),
      item({
        id: "url:https://a.test/x#frag",
        kind: "url",
        url: "https://a.test/x#frag",
        lastSeen: NOW - 3 * DAY_MS,
        sources: ["user@3"],
      }),
    ];
    expect(tidyIds(all, NOW).sort()).toEqual([
      "linear:ENG-9",
      "subagent:bad",
      "subagent:done",
      "url:https://a.test/x#frag",
      "url:https://a.test/y",
    ]);
  });

  it("does not offer an item that is already tidied", () => {
    expect(tidyIds([sub("done", "done", { tidied: { by: "isaac", at: NOW } })], NOW)).toEqual([]);
  });
});
