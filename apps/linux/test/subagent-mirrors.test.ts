import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, Artifact } from "@relay/protocol";
import { SubagentFileMirrors, type MirrorDeps, type MirrorLink } from "../src/agents/subagent-mirrors";

const NOW = Date.UTC(2026, 10, 5, 13, 30);

const entry = (role: "user" | "assistant", text: string, at = NOW - 60_000): string =>
  `${JSON.stringify({ type: "message", id: `m${String(Math.random())}`, timestamp: new Date(at).toISOString(), message: { role, content: [{ type: "text", text }], timestamp: at } })}\n`;

interface Opened {
  frames: Record<string, unknown>[];
  ask: (frame: { t: string; id: string; imageId?: string }) => void;
  closed: boolean;
  gone: () => void;
}

describe("SubagentFileMirrors", () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.length = 0;
  });

  function setup(over: Partial<MirrorDeps> = {}) {
    const root = mkdtempSync(join(tmpdir(), "mirrors-"));
    dirs.push(root);
    const threadFile = join(root, "2026T_abc.jsonl");
    writeFileSync(threadFile, "");
    const folder = join(root, "2026T_abc");
    mkdirSync(folder);
    const parent: AgentSession = { id: "abc", provider: "omp", title: "Nova", projectPath: "/Users/ike/Eva", status: "idle", lastActivity: "", lastActivityAt: 1, canRespond: true, account: { profile: "personal" } };
    const opened: Opened[] = [];
    const listed: AgentSession[] = [parent];
    const logs: string[] = [];
    let helpers: { thread: string; item: Artifact }[] = [];
    const helper = (name: string, state: "running" | "done", over: Partial<Artifact> = {}): { thread: string; item: Artifact } => ({
      thread: "assistant:nova",
      item: {
        id: `subagent:${join(folder, `${name}.jsonl`)}`,
        kind: "subagent",
        title: name,
        path: join(folder, `${name}.jsonl`),
        subagent: { state, startedAt: NOW - 120_000, ...(state === "running" ? { line: "Reading files" } : { endedAt: NOW - 30_000 }) },
        mentions: 1,
        firstSeen: NOW - 120_000,
        lastSeen: NOW - 30_000,
        sources: [],
        addedBy: "extractor",
        from: "assistant",
        ...over,
      },
    });
    const deps: MirrorDeps = {
      helpers: () => helpers,
      sessions: () => listed,
      sessionForFile: (file) => (file === threadFile ? parent : null),
      open: (onFrame, onClose): MirrorLink => {
        const link: Opened = {
          frames: [],
          ask: onFrame,
          closed: false,
          gone: onClose,
        };
        opened.push(link);
        return {
          send: (frame) => {
            link.frames.push(frame as Record<string, unknown>);
          },
          close: () => {
            link.closed = true;
          },
        };
      },
      now: () => NOW,
      log: (line) => logs.push(line),
      ...over,
    };
    const mirrors = new SubagentFileMirrors(deps);
    return { mirrors, opened, listed, parent, folder, logs, helper, setHelpers: (next: typeof helpers) => (helpers = next) };
  }

  it("opens a session for a running helper no real mirror covers: parentId, account, working, read-only", () => {
    const { mirrors, opened, folder, helper, setHelpers } = setup();
    const h = helper("HandDrawnLora", "running");
    writeFileSync(join(folder, "HandDrawnLora.jsonl"), entry("user", "do it") + entry("assistant", "Looking at the LoRA\nmore"));
    setHelpers([h]);
    mirrors.refresh();
    expect(mirrors.ids).toEqual(["abc:HandDrawnLora"]);
    expect(opened[0]?.frames[0]).toMatchObject({ t: "hello", sessionId: "abc:HandDrawnLora", parentId: "abc", provider: "omp", title: "HandDrawnLora", status: "working", statusDetail: "Reading files", canRespond: false, projectPath: "/Users/ike/Eva", account: { profile: "personal" }, lastActivity: "Looking at the LoRA" });
  });

  it("answers the conversation from the file and follows its new lines live", () => {
    const { mirrors, opened, folder, helper, setHelpers } = setup();
    const file = join(folder, "Scout.jsonl");
    writeFileSync(file, entry("user", "go"));
    setHelpers([helper("Scout", "running")]);
    mirrors.refresh();
    const link = opened[0];
    link?.ask({ t: "conversation", id: "c1" });
    expect(link?.frames.at(-1)).toMatchObject({ t: "result", id: "c1", ok: true, value: [{ role: "user", text: "go" }] });

    appendFileSync(file, entry("assistant", "Found it"));
    mirrors.refresh();
    expect(link?.frames.find((f) => f["t"] === "messages")).toMatchObject({ append: [{ role: "assistant", text: "Found it" }] });
    expect(link?.frames.at(-1)).toMatchObject({ t: "status", status: "working", lastActivity: "Found it" });
  });

  it("reports a finished helper as ended with Done, and refuses to message or stop it", () => {
    const { mirrors, opened, folder, helper, setHelpers } = setup();
    writeFileSync(join(folder, "Old.jsonl"), entry("user", "x"));
    setHelpers([helper("Old", "done")]);
    mirrors.refresh();
    const link = opened[0];
    expect(link?.frames[0]).toMatchObject({ status: "ended", statusDetail: "Done", canRespond: false });
    link?.ask({ t: "reply", id: "r1" });
    expect(link?.frames.at(-1)).toMatchObject({ t: "result", id: "r1", ok: false });
    link?.ask({ t: "abort", id: "a1" });
    expect(link?.frames.at(-1)).toMatchObject({ ok: false });
  });

  it("moves a mirror to ended when the helper finishes", () => {
    const { mirrors, opened, folder, helper, setHelpers } = setup();
    writeFileSync(join(folder, "Job.jsonl"), entry("user", "x"));
    setHelpers([helper("Job", "running")]);
    mirrors.refresh();
    setHelpers([helper("Job", "done")]);
    mirrors.refresh();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.frames.at(-1)).toMatchObject({ t: "status", status: "ended", statusDetail: "Done" });
  });

  it("leaves a helper alone when a real mirror of its session is listed", () => {
    const { mirrors, opened, folder, helper, setHelpers, listed, parent } = setup();
    writeFileSync(join(folder, "Real.jsonl"), "");
    listed.push({ ...parent, id: "abc:Real", parentId: "abc" });
    setHelpers([helper("Real", "running")]);
    mirrors.refresh();
    expect(opened).toHaveLength(0);
    expect(mirrors.ids).toEqual([]);
  });

  it("opens nothing for a helper whose thread is not a live session", () => {
    const { mirrors, opened, helper, setHelpers } = setup({ sessionForFile: () => null });
    setHelpers([helper("Orphan", "running")]);
    mirrors.refresh();
    expect(opened).toHaveLength(0);
  });

  it("closes the mirror when the helper leaves the list or the thread ends", () => {
    const { mirrors, opened, folder, helper, setHelpers } = setup();
    writeFileSync(join(folder, "Gone.jsonl"), "");
    setHelpers([helper("Gone", "running")]);
    mirrors.refresh();
    setHelpers([]);
    mirrors.refresh();
    expect(opened[0]?.closed).toBe(true);
    expect(mirrors.ids).toEqual([]);
  });

  it("clearing a finished helper keeps it off until it does something new", () => {
    const { mirrors, opened, folder, helper, setHelpers } = setup();
    writeFileSync(join(folder, "Tidy.jsonl"), "");
    setHelpers([helper("Tidy", "done")]);
    mirrors.refresh();
    vi.useFakeTimers();
    opened[0]?.ask({ t: "end", id: "e1" });
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    expect(opened[0]?.closed).toBe(true);
    mirrors.refresh();
    expect(opened).toHaveLength(1);
    setHelpers([helper("Tidy", "running")]);
    mirrors.refresh();
    expect(opened).toHaveLength(2);
  });

  it("keeps only the newest finished helpers listed", () => {
    const { mirrors, folder, helper, setHelpers } = setup();
    const all = Array.from({ length: 23 }, (_, i) => {
      writeFileSync(join(folder, `H${String(i)}.jsonl`), "");
      return helper(`H${String(i)}`, "done", { subagent: { state: "done", startedAt: NOW - 500_000, endedAt: NOW - 400_000 + i * 1000 } });
    });
    setHelpers(all);
    mirrors.refresh();
    expect(mirrors.ids).toHaveLength(20);
    expect(mirrors.ids).not.toContain("abc:H0");
  });
});
