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
  tabItems,
  type Artifact,
  type ArtifactTab,
} from "../src";

const NOW = new Date(2026, 9, 27, 21, 47).getTime();

function item(over: Partial<Artifact> & Pick<Artifact, "id" | "kind">): Artifact {
  return { title: over.id, mentions: 1, firstSeen: NOW - 1000, lastSeen: NOW - 1000, sources: [], addedBy: "extractor", ...over };
}

const pr = item({ id: "gh-pr:o/r#1", kind: "gh-pr", repo: "eCardSystems/react-client-reports-app", status: { state: "open", draft: true, fetchedAt: NOW } });
const merged = item({ id: "gh-pr:o/r#2", kind: "gh-pr", status: { state: "merged", fetchedAt: NOW, changedAt: NOW - 3 * DAY_MS } });
const ticket = item({ id: "linear:ENG-1", kind: "linear", status: { state: "in progress", stateType: "started", fetchedAt: NOW } });
const old = item({ id: "url:https://a.dev", kind: "url", lastSeen: NOW - 8 * DAY_MS });
const pinnedOld = item({ id: "url:https://b.dev", kind: "url", lastSeen: NOW - 30 * DAY_MS, pinned: { by: "astra", at: NOW - 5 } });
const proof = item({ id: "drop:1", kind: "drop", caption: "Before/after of the header", media: { mimeType: "image/png" } });
const running = item({ id: "subagent:/a.jsonl", kind: "subagent", lastSeen: NOW - 5 * DAY_MS, subagent: { state: "running", startedAt: NOW - 5 * DAY_MS } });
const yesterday = item({ id: "subagent:/b.jsonl", kind: "subagent", subagent: { state: "done", startedAt: NOW - DAY_MS, endedAt: NOW - DAY_MS } });
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
    expect(sameRule({ kind: ["gh-pr", "linear"], state: ["Open"] }, { state: ["open"], kind: ["linear", "gh-pr"] })).toBe(true);
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
    const [subagents, links, media, everything] = defaultTabs();
    expect(defaultTabs().map((tab) => tab.title)).toEqual(["Subagents", "Links", "Media", "Everything"]);
    expect(tabItems(subagents as ArtifactTab, items, NOW).map((found) => found.id)).toEqual(["subagent:/a.jsonl"]);
    expect(tabItems(links as ArtifactTab, items, NOW).map((found) => found.id)).toEqual(["url:https://b.dev", "gh-pr:o/r#1", "linear:ENG-1"]);
    expect(tabItems(media as ArtifactTab, items, NOW).map((found) => found.id)).toEqual(["drop:1"]);
    expect(tabItems(everything as ArtifactTab, items, NOW)[0]?.id).toBe("url:https://b.dev");
    expect(tabItems(everything as ArtifactTab, items, NOW)[1]?.id).toBe("subagent:/a.jsonl");
  });

  it("shows an item tab's picks in order (they never fade), pinned first, skipping unknown ids", () => {
    const tab: ArtifactTab = { id: "picks", title: "Picks", createdBy: "astra", createdAt: NOW, items: ["url:https://a.dev", "nope", "url:https://b.dev"], hidden: false };
    expect(tabItems(tab, items, NOW).map((found) => found.id)).toEqual(["url:https://b.dev", "url:https://a.dev"]);
  });
});

describe("artifacts frames", () => {
  it("parses get, act, snapshot and acted, and rejects a bad rule", () => {
    expect(parseClientMessage(JSON.stringify({ t: "artifacts.get", thread: "assistant:astra" })).ok).toBe(true);
    const act = { t: "artifacts.act", thread: "session:01a1", rid: "r1", by: "astra", action: { op: "tab.add", title: "Open PRs", icon: "git-pull-request", rule: { kind: ["gh-pr"], state: ["open"] } } };
    expect(parseClientMessage(JSON.stringify(act))).toEqual({ ok: true, value: act });
    expect(parseClientMessage(JSON.stringify({ ...act, action: { op: "tab.add", title: "x", rule: { kind: ["nope"] } } })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ ...act, action: { op: "tab.add", title: "x", rule: { colour: "red" } } })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "artifacts.snapshot", thread: "assistant:nova", items, tabs: defaultTabs() })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ t: "artifacts.acted", rid: "r1", ok: false, error: "Isaac hid it." })).ok).toBe(true);
  });
});
