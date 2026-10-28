import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultTabs, type Artifact, type Drop, type ServerMessage } from "@relay/protocol";
import { classifyUrl, findInText, scanTranscript, type ScanContext } from "../src/artifacts/extract";
import { ArtifactService, SUBAGENT_POLL_MS } from "../src/artifacts/service";

const T0 = Date.parse("2026-10-27T12:00:00Z");
const DROP_ID = "6d796135-613d-4bd8-ae3f-d928a50f7535";
const TOKEN = "a".repeat(64);

function ctx(over: Partial<ScanContext> = {}): ScanContext {
  return { file: "/s/2026_x.jsonl", evaRoot: "/Eva", repo: null, exists: () => false, fresh: false, ...over };
}

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function user(at: number, content: unknown): string {
  return line({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "user", timestamp: at, content } });
}

function assistant(at: number, content: unknown): string {
  return line({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", timestamp: at, content } });
}

describe("classifyUrl", () => {
  it("keys Linear issues and GitHub PRs/issues, strips fragments and tracking, and skips namespaces and local hosts", () => {
    expect(classifyUrl("https://linear.app/ecard-systems/issue/ENG-6528/egift-order-hub-is-malformed).")).toMatchObject({
      id: "linear:ENG-6528",
      title: "Egift order hub is malformed",
      url: "https://linear.app/ecard-systems/issue/ENG-6528",
    });
    expect(classifyUrl("https://github.com/eCardSystems/react-client-reports-app/pull/238/files#diff-1")).toMatchObject({
      id: "gh-pr:eCardSystems/react-client-reports-app#238",
      repo: "eCardSystems/react-client-reports-app",
    });
    expect(classifyUrl("https://github.com/webosbrew/webos-homebrew-channel/issues/183#issuecomment-9")?.id).toBe("gh-issue:webosbrew/webos-homebrew-channel#183");
    expect(classifyUrl("https://Example.dev/post/?utm_source=x&id=3#top")?.id).toBe("url:https://example.dev/post/?id=3");
    expect(classifyUrl("https://lindy.ai/blog/a/")?.id).toBe("url:https://lindy.ai/blog/a");
    expect(classifyUrl("http://www.w3.org/2000/svg")).toBeNull();
    expect(classifyUrl("http://localhost:3000/x")).toBeNull();
    expect(classifyUrl("http://localhost:3000/x", true)?.id).toBe("url:http://localhost:3000/x");
  });
});

describe("findInText", () => {
  it("finds drops with captions, bare tickets, repo refs, bare #n only with a repo, branches and files that exist", () => {
    const text = [
      `![Note sheet](/drops/${DROP_ID}/${TOKEN}) and ENG-6524 plus eCardSystems/react-client-reports-app#237.`,
      "PR #236 is on fix/ENG-6524-list-contrast; see work/notes/a.md and /Users/ike/Eva/work/b.png, not work/missing.md.",
    ].join("\n");
    const exists = (path: string): boolean => path === "/Eva/work/notes/a.md" || path === "/Users/ike/Eva/work/b.png";
    const ids = findInText(text, ctx({ exists })).map((found) => found.id);
    expect(ids).toEqual([
      `drop:${DROP_ID}`,
      "linear:ENG-6524",
      "gh-pr:eCardSystems/react-client-reports-app#237",
      "branch:fix/ENG-6524-list-contrast",
      "file:/Users/ike/Eva/work/b.png",
      "file:/Eva/work/notes/a.md",
    ]);
    const found = findInText(text, ctx({ exists, repo: "eCardSystems/react-client-reports-app" }));
    expect(found.map((item) => item.id)).toContain("gh-pr:eCardSystems/react-client-reports-app#236");
    expect(found[0]).toMatchObject({ caption: "Note sheet", title: "Note sheet", url: `/drops/${DROP_ID}/${TOKEN}` });
    expect(found.find((item) => item.id.endsWith("b.png"))?.media).toEqual({ mimeType: "image/png" });
  });

  it("files paths under work/experiments as Test Bench runs", () => {
    const exists = (path: string): boolean => path === "/Eva/work/experiments/2026-10-27-ui-check" || path === "/Eva/work/experiments/2026-10-27-ui-check/report.md";
    expect(findInText("see work/experiments/2026-10-27-ui-check/report.md", ctx({ exists })).map((found) => found.id)).toEqual(["experiment:2026-10-27-ui-check"]);
  });
});

describe("scanTranscript", () => {
  it("skips the prime, tool results and custom messages; counts each message once; reads subagents and pasted images", () => {
    const raw = [
      line({ type: "session", cwd: "/repo" }),
      user(T0, [{ type: "text", text: "You are Astra, Isaac's assistant. ENG-1111" }]),
      user(T0 + 1, [{ type: "text", text: "<surface>Relay Desktop</surface>\nLook at ENG-6528 and ENG-6528 again" }, { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }]),
      assistant(T0 + 2, [
        { type: "text", text: "On it: https://linear.app/ecard-systems/issue/ENG-6528" },
        { type: "toolCall", name: "task", arguments: { tasks: [{ name: "Fix6528", task: "ENG-9999" }] } },
        { type: "toolCall", name: "read", arguments: { path: "work/experiments/x/y.md" } },
      ]),
      line({ type: "message", timestamp: new Date(T0 + 3).toISOString(), message: { role: "toolResult", toolName: "bash", timestamp: T0 + 3, content: [{ type: "text", text: "ENG-7777" }] } }),
      line({ type: "custom_message", customType: "eren", content: "ENG-5555", timestamp: new Date(T0 + 4).toISOString() }),
      line({ type: "custom_message", customType: "async-result", timestamp: new Date(T0 + 5).toISOString(), content: '<task-result id="Fix6528" agent="task" status="completed" duration="1m">' }),
      "{half a line",
    ].join("");
    const result = scanTranscript(raw, ctx({ fresh: true }));
    expect(result.cwd).toBe("/repo");
    expect(result.fresh).toBe(false);
    expect(result.messages.map((message) => [message.key, message.found.map((found) => found.id)])).toEqual([
      ["user@" + String(T0 + 1), [expect.stringMatching(/^image:[0-9a-f]{32}$/), "linear:ENG-6528"]],
      ["assistant@" + String(T0 + 2), ["linear:ENG-6528", "subagent:/s/2026_x/Fix6528.jsonl"]],
    ]);
    expect(result.messages[0]?.found[0]).toMatchObject({ kind: "image", caption: "Look at ENG-6528 and ENG-6528 again", media: { mimeType: "image/png" } });
    expect(result.ended).toEqual([{ name: "Fix6528", failed: false, at: T0 + 5 }]);
  });
});

interface Harness {
  readonly service: ArtifactService;
  readonly sent: ServerMessage[];
  readonly root: string;
  readonly files: string[];
  now: number;
  readonly timers: { at: number; fn: () => void }[];
  tick(ms: number): void;
  snapshot(thread?: string): Extract<ServerMessage, { t: "artifacts.snapshot" }>;
}

function harness(options: { root?: string; drops?: Drop[] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-"));
  const root = options.root ?? join(dir, "artifacts");
  const sent: ServerMessage[] = [];
  const files: string[] = [];
  const h: Harness = {
    sent,
    root,
    files,
    now: T0 + 60_000,
    timers: [],
    service: undefined as unknown as ArtifactService,
    tick(ms) {
      h.now += ms;
      for (const timer of h.timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (timer.at <= h.now) timer.fn();
        else h.timers.push(timer);
      }
    },
    snapshot(thread = "assistant:astra") {
      const last = sent.filter((message): message is Extract<ServerMessage, { t: "artifacts.snapshot" }> => message.t === "artifacts.snapshot" && message.thread === thread).at(-1);
      if (last === undefined) throw new Error("no snapshot");
      return last;
    },
  };
  Object.assign(h, {
    service: new ArtifactService({
      root,
      evaRoot: dir,
      broadcast: (message) => void sent.push(message),
      threadFiles: () => files,
      threadOf: (id) => (id === "live" ? "assistant:astra" : null),
      drop: (id) => options.drops?.find((drop) => drop.id === id),
      repoOf: () => null,
      clock: {
        now: () => h.now,
        after: (ms, fn) => {
          const timer = { at: h.now + ms, fn };
          h.timers.push(timer);
          return () => h.timers.splice(h.timers.indexOf(timer), 1);
        },
      },
      log: () => undefined,
    }),
  });
  return h;
}

function transcript(h: Harness, name = "2026-10-27_a.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const file = join(dir, name);
  writeFileSync(file, "");
  h.files.push(file);
  return file;
}

function item(h: Harness, id: string): Artifact | undefined {
  return h.snapshot().items.find((candidate) => candidate.id === id);
}

describe("ArtifactService", () => {
  it("reads transcripts incrementally, dedupes by key, and keeps the newest sources", () => {
    const h = harness();
    const file = transcript(h);
    appendFileSync(file, user(T0, "ENG-6528 please") + assistant(T0 + 10, "Fixed ENG-6528 in https://github.com/o/r/pull/9"));
    h.service.get("assistant:astra");
    expect(item(h, "linear:ENG-6528")).toMatchObject({ mentions: 2, firstSeen: T0, lastSeen: T0 + 10, from: "user", addedBy: "extractor", sources: [`assistant@${T0 + 10}`, `user@${T0}`] });
    expect(h.snapshot().tabs).toEqual(defaultTabs());
    appendFileSync(file, assistant(T0 + 20, "ENG-6528 is done"));
    h.service.get("assistant:astra");
    expect(item(h, "linear:ENG-6528")?.mentions).toBe(3);
    // A second get with nothing new does not count again.
    h.service.get("assistant:astra");
    expect(item(h, "linear:ENG-6528")?.mentions).toBe(3);
  });

  it("rescans on conversation changes after a settle delay and survives a restart", () => {
    const h = harness();
    const file = transcript(h);
    appendFileSync(file, user(T0, "ENG-1000"));
    h.service.observe({ kind: "conversation", sessionId: "live", appended: [] });
    h.service.observe({ kind: "conversation", sessionId: "live", appended: [] });
    expect(h.sent).toEqual([]);
    h.tick(2000);
    expect(h.sent).toHaveLength(1);
    const again = harness({ root: h.root });
    again.files.push(file);
    again.service.get("assistant:astra");
    expect(again.snapshot().items.map((found) => [found.id, found.mentions])).toEqual([["linear:ENG-1000", 1]]);
  });

  it("skips transcripts nobody wrote to this week on a thread's first read", () => {
    const h = harness();
    const file = transcript(h);
    appendFileSync(file, user(T0, "ENG-1000"));
    utimesSync(file, new Date(T0 - 10 * 86_400_000), new Date(T0 - 10 * 86_400_000));
    h.service.get("assistant:astra");
    expect(h.snapshot().items).toEqual([]);
  });

  it("fills drops from the drop box and serves pasted images by token", () => {
    const drop: Drop = {
      id: DROP_ID,
      kind: "file",
      origin: "host",
      createdAt: T0,
      title: "clip.mp4",
      file: { name: "clip.mp4", mimeType: "video/mp4", size: 9, path: `/drops/${DROP_ID}/${TOKEN}`, durationMs: 4200, poster: `/drops/${DROP_ID}/${TOKEN}/poster` },
    };
    const h = harness({ drops: [drop] });
    const file = transcript(h);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    appendFileSync(file, user(T0, [{ type: "text", text: "this one" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }]));
    appendFileSync(file, assistant(T0 + 1, `![Before and after](/drops/${DROP_ID}/${TOKEN}) and /drops/11111111-1111-1111-1111-111111111111/${TOKEN}`));
    h.service.get("assistant:astra");
    const items = h.snapshot().items;
    expect(items.map((found) => found.kind).sort()).toEqual(["drop", "image"]);
    expect(items.find((found) => found.kind === "drop")).toMatchObject({ caption: "Before and after", media: { mimeType: "video/mp4", durationMs: 4200, poster: `/drops/${DROP_ID}/${TOKEN}/poster` } });
    const image = items.find((found) => found.kind === "image");
    const [, , , sha = "", token = ""] = (image?.url ?? "").split("/");
    const blob = h.service.openMedia(sha, token);
    expect(blob).toMatchObject({ mimeType: "image/png", size: 4 });
    expect(readFileSync(blob?.path ?? "")).toEqual(png);
    expect(h.service.openMedia(sha, "b".repeat(64))).toBeNull();
    const fresh = harness({ root: h.root });
    fresh.service.loadAll();
    expect(fresh.service.openMedia(sha, token)).not.toBeNull();
  });

  it("reads pasted images from omp's blob store and drops images an older host stored broken", () => {
    const h = harness();
    const base = mkdtempSync(join(tmpdir(), "omp-"));
    mkdirSync(join(base, "agent", "sessions", "-Eva"), { recursive: true });
    mkdirSync(join(base, "agent", "blobs"));
    const hex = "9".repeat(64);
    const webp = Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1"), Buffer.from("rest")]);
    writeFileSync(join(base, "agent", "blobs", hex), webp);
    const file = join(base, "agent", "sessions", "-Eva", "2026-10-27_b.jsonl");
    writeFileSync(file, user(T0, [{ type: "text", text: "ENG-1000 look" }, { type: "image", data: `blob:sha256:${hex}`, mimeType: "image/webp" }]));
    h.files.push(file);
    // What 0.2.30 left behind: the ref's text decoded as base64, under the old id.
    mkdirSync(join(h.root, "media"), { recursive: true });
    writeFileSync(join(h.root, "media", "b".repeat(32)), Buffer.from("blob:sha256", "base64"));
    mkdirSync(join(h.root, "assistant-astra"), { recursive: true });
    const stale: Artifact = { id: `image:${"b".repeat(32)}`, kind: "image", title: "Pasted image", mentions: 1, firstSeen: T0, lastSeen: T0, sources: [`user@${T0}`], addedBy: "extractor" };
    const ticket: Artifact = { id: "linear:ENG-1000", kind: "linear", title: "ENG-1000", mentions: 1, firstSeen: T0, lastSeen: T0, sources: [`user@${T0}`], addedBy: "extractor" };
    writeFileSync(join(h.root, "assistant-astra", "artifacts.json"), JSON.stringify({ version: 1, items: [stale, ticket], scans: { [file]: { offset: 99999, fresh: false } } }));
    h.service.get("assistant:astra");
    const items = h.snapshot().items;
    expect(items.map((found) => found.id).sort()).toEqual([`image:${hex.slice(0, 32)}`, "linear:ENG-1000"]);
    expect(items.find((found) => found.id === "linear:ENG-1000")?.mentions).toBe(1);
    const [, , , sha = "", token = ""] = (items.find((found) => found.kind === "image")?.url ?? "").split("/");
    expect(readFileSync(h.service.openMedia(sha, token)?.path ?? "")).toEqual(webp);
  });

  it("follows subagents: status line from the transcript, done by the result file, children nested", () => {
    const h = harness();
    const file = transcript(h);
    appendFileSync(file, assistant(T0, [{ type: "toolCall", name: "task", arguments: { tasks: [{ name: "Builder" }] } }]));
    const sub = file.replace(/\.jsonl$/, "");
    mkdirSync(join(sub, "Builder"), { recursive: true });
    writeFileSync(join(sub, "Builder.jsonl"), line({ type: "custom", customType: "tool_execution_start", data: { intent: "Reading herdr launch" } }));
    writeFileSync(join(sub, "Builder", "Builder.Scout.jsonl"), "");
    h.now = Date.now();
    h.service.get("assistant:astra");
    expect(item(h, `subagent:${join(sub, "Builder.jsonl")}`)?.subagent).toMatchObject({ state: "running", line: "Reading herdr launch" });
    expect(item(h, `subagent:${join(sub, "Builder", "Builder.Scout.jsonl")}`)).toMatchObject({ title: "Scout", subagent: { state: "running", parent: `subagent:${join(sub, "Builder.jsonl")}` } });
    writeFileSync(join(sub, "Builder.md"), "done");
    writeFileSync(join(sub, "Builder", "Builder.Scout.md"), "done");
    const before = h.sent.length;
    h.tick(SUBAGENT_POLL_MS);
    expect(h.sent.length).toBe(before + 1);
    expect(item(h, `subagent:${join(sub, "Builder.jsonl")}`)?.subagent?.state).toBe("done");
    expect(item(h, `subagent:${join(sub, "Builder", "Builder.Scout.jsonl")}`)?.subagent?.state).toBe("done");
  });
});

describe("ArtifactService acts", () => {
  function seeded(): Harness {
    const h = harness();
    appendFileSync(transcript(h), user(T0, "ENG-6528 and https://github.com/o/r/pull/9"));
    h.service.get("assistant:astra");
    return h;
  }

  it("pins and unpins, recording who pinned", () => {
    const h = seeded();
    expect(h.service.act("assistant:astra", "astra", { op: "pin", id: "linear:ENG-6528", pinned: true })).toEqual({ ok: true });
    expect(item(h, "linear:ENG-6528")?.pinned).toEqual({ by: "astra", at: h.now });
    expect(h.service.act("assistant:astra", "isaac", { op: "pin", id: "linear:ENG-6528", pinned: false })).toEqual({ ok: true });
    expect(item(h, "linear:ENG-6528")?.pinned).toBeUndefined();
    expect(h.service.act("assistant:astra", "isaac", { op: "pin", id: "nope", pinned: true }).ok).toBe(false);
  });

  it("refuses agent tabs that repeat a default, a hidden tab, or a visible one; Isaac's hide is sticky", () => {
    const h = seeded();
    const links = h.service.act("assistant:astra", "astra", { op: "tab.add", title: "Links again", rule: { kind: ["url", "branch", "gh-pr", "gh-issue", "linear"] } });
    expect(links.ok).toBe(false);
    expect(links.error).toContain('default "Links" tab');
    const prs = h.service.act("assistant:astra", "astra", { op: "tab.add", title: "Open PRs", icon: "git-pull-request", rule: { kind: ["gh-pr"], state: ["open"] } });
    expect(prs).toEqual({ ok: true, id: "open-prs" });
    expect(h.snapshot().tabs.at(-1)).toMatchObject({ id: "open-prs", createdBy: "astra", createdAt: h.now, fresh: true, hidden: false });
    expect(h.service.act("assistant:astra", "nova", { op: "tab.add", title: "PRs", rule: { state: ["OPEN"], kind: ["gh-pr"] } }).error).toContain("reuse it");
    expect(h.service.act("assistant:astra", "astra", { op: "tab.update", tab: "open-prs", hidden: true }).ok).toBe(false);
    expect(h.service.act("assistant:astra", "isaac", { op: "tab.update", tab: "open-prs", hidden: true, fresh: false })).toEqual({ ok: true });
    expect(h.service.act("assistant:astra", "astra", { op: "tab.add", title: "Open PRs", rule: { kind: ["gh-pr"], state: ["open"] } }).error).toContain("Isaac hid");
    expect(h.snapshot().tabs.find((tab) => tab.id === "open-prs")).toMatchObject({ hidden: true });
    expect(h.snapshot().tabs.find((tab) => tab.id === "open-prs")?.fresh).toBeUndefined();
  });

  it("lets agents change and remove only their own tabs; defaults are never removed", () => {
    const h = seeded();
    h.service.act("assistant:astra", "astra", { op: "tab.add", title: "Picks", items: ["linear:ENG-6528"] });
    expect(h.service.act("assistant:astra", "nova", { op: "tab.update", tab: "picks", title: "Mine" }).ok).toBe(false);
    expect(h.service.act("assistant:astra", "astra", { op: "tab.update", tab: "picks", title: "Astra's picks", index: 0 })).toEqual({ ok: true });
    expect(h.snapshot().tabs.map((tab) => tab.id)).toEqual(["picks", "subagents", "links", "media", "everything"]);
    expect(h.service.act("assistant:astra", "astra", { op: "add", kind: "gh-pr", title: "PR 9", url: "https://github.com/o/r/pull/9", tab: "picks" })).toEqual({ ok: true, id: "gh-pr:o/r#9" });
    expect(h.snapshot().tabs[0]).toMatchObject({ title: "Astra's picks", items: ["linear:ENG-6528", "gh-pr:o/r#9"] });
    expect(h.service.act("assistant:astra", "astra", { op: "tab.add", title: "Ghost", items: ["linear:ENG-1"] }).error).toContain("Unknown artifact ids");
    expect(h.service.act("assistant:astra", "isaac", { op: "tab.remove", tab: "links" }).ok).toBe(false);
    expect(h.service.act("assistant:astra", "nova", { op: "tab.remove", tab: "picks" }).ok).toBe(false);
    expect(h.service.act("assistant:astra", "astra", { op: "tab.remove", tab: "picks" })).toEqual({ ok: true });
    expect(h.snapshot().tabs).toEqual(defaultTabs());
  });

  it("takes live states, stamping a state change and broadcasting only real changes", () => {
    const h = seeded();
    const before = h.sent.length;
    h.service.act("assistant:astra", "relay-desktop", { op: "status", statuses: { "gh-pr:o/r#9": { state: "open", checks: "pass", title: "Fix login", fetchedAt: h.now } } });
    expect(h.sent.length).toBe(before + 1);
    expect(item(h, "gh-pr:o/r#9")).toMatchObject({ title: "Fix login", status: { state: "open", checks: "pass", fetchedAt: h.now } });
    expect(item(h, "gh-pr:o/r#9")?.status?.changedAt).toBeUndefined();
    h.service.act("assistant:astra", "relay-desktop", { op: "status", statuses: { "gh-pr:o/r#9": { state: "open", checks: "pass", title: "Fix login", fetchedAt: h.now + 1 } } });
    expect(h.sent.length).toBe(before + 1);
    h.now += 5;
    h.service.act("assistant:astra", "relay-desktop", { op: "status", statuses: { "gh-pr:o/r#9": { state: "merged", fetchedAt: h.now } } });
    expect(item(h, "gh-pr:o/r#9")?.status).toMatchObject({ state: "merged", changedAt: h.now });
    const saved = JSON.parse(readFileSync(join(h.root, "assistant-astra", "artifacts.json"), "utf8")) as { items: Artifact[] };
    expect(saved.items.find((found) => found.id === "gh-pr:o/r#9")?.status?.state).toBe("merged");
    expect(existsSync(join(h.root, "assistant-astra", "tabs.json"))).toBe(true);
  });
});
