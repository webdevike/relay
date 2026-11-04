import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentSession, ServerMessage } from "@relay/protocol";
import { toolCallOf } from "../src/agents/transcript";
import type { AssistantAgentConfig } from "../src/assistant/registry";
import { CLAIM_MS, FilePresence, SETTLE_MS, UNKNOWN_AGENT } from "../src/files/presence";
import type { FileClient, FrameSink } from "../src/seams";
import type { SessionClock } from "../src/session";

class Clock implements SessionClock {
  t = 1_000_000;
  private timers: Array<{ at: number; fn: () => void }> = [];
  now(): number {
    return this.t;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((t) => t.at <= this.t);
    this.timers = this.timers.filter((t) => t.at > this.t);
    for (const t of due) t.fn();
  }
}

class Sink implements FrameSink {
  readonly sent: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  close(): void {}
  of<T extends ServerMessage["t"]>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

const session = (s: Partial<AgentSession> & { id: string }): AgentSession => ({
  provider: "omp",
  title: "Eva",
  projectPath: "/nowhere",
  status: "working",
  lastActivity: "",
  lastActivityAt: 0,
  canRespond: true,
  ...s,
});

const toolRow = (name: string, args: Record<string, unknown>): AgentMessage => ({ id: `m-${name}`, role: "tool", text: "", at: 0, tool: toolCallOf(name, args) });

const registry: AssistantAgentConfig[] = [
  { id: "nova", title: "Nova", portrait: { style: "notionists", seed: "nova", colors: { accent: "#12b886" } } },
];

describe("FilePresence", () => {
  let dir: string;
  let clock: Clock;
  let sessions: AgentSession[];
  let watchers: Map<string, (name: string | null) => void>;
  let presence: FilePresence;
  const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-presence-"));
    clock = new Clock();
    sessions = [];
    watchers = new Map();
    presence = new FilePresence({
      sessions: () => sessions,
      registry: () => registry,
      defaultAgentName: () => undefined,
      watchDir: (d, onChange) => {
        watchers.set(d, onChange);
        return () => watchers.delete(d);
      },
      clock,
      log: () => undefined,
    });
  });

  afterEach(() => {
    presence.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const client = (device: string, sink = new Sink()): FileClient & { sink: Sink } => ({ sink, device, deviceName: `${device} name` });

  /** Writes `text` and lets the folder watcher's event settle, as an agent's write would. */
  function write(file: string, text: string): void {
    writeFileSync(file, text);
    watchers.get(dir)?.(file.slice(dir.length + 1));
    clock.advance(SETTLE_MS);
  }

  it("names the assistant whose edit tool wrote the open file, with the lines and the caret", () => {
    const file = join(dir, "notes.md");
    writeFileSync(file, "one\ntwo\nthree\n");
    const mini = client("mini");
    presence.open(mini, [file]);
    sessions = [session({ id: "s-nova", kind: "assistant", assistant: "nova", title: "Nova", projectPath: dir })];
    presence.observe({ kind: "conversation", sessionId: "s-nova", appended: [toolRow("edit", { i: "Tightening the notes", input: "[notes.md#1A2B]\nPUT 2:\n+TWO" })] });
    write(file, "one\nTWO\nthree\n");
    expect(mini.sink.of("files.edit")).toEqual([
      {
        t: "files.edit",
        path: file,
        hash: sha1("one\nTWO\nthree\n"),
        ranges: [{ startLine: 2, endLine: 2 }],
        caret: { line: 2, column: 4 },
        agent: { name: "Nova", color: "#12b886", avatar: "/canvas/avatar/nova", sessionId: "s-nova" },
        intent: "Tightening the notes",
        at: clock.t,
      },
    ]);
  });

  it("draws a helper by its own name in its assistant's color", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "a\n");
    const mini = client("mini");
    presence.open(mini, [file]);
    sessions = [
      session({ id: "s-nova", kind: "assistant", assistant: "nova", title: "Nova" }),
      session({ id: "s-helper", title: "LiveFileCursors", parentId: "s-nova", projectPath: "/elsewhere" }),
    ];
    // Named relative to a folder that is not the file's: matched by its tail.
    presence.observe({ kind: "conversation", sessionId: "s-helper", appended: [toolRow("write", { path: "a.ts", content: "b\n" })] });
    write(file, "b\n");
    expect(mini.sink.of("files.edit")[0]?.agent).toEqual({ name: "LiveFileCursors", color: "#12b886", avatar: "/canvas/portrait/livefilecursors", sessionId: "s-helper" });
  });

  it("calls an unclaimed or long-ago-claimed change 'Agent', and a plain chat's edit Eva", () => {
    const file = join(dir, "x.txt");
    writeFileSync(file, "1\n");
    const mini = client("mini");
    presence.open(mini, [file]);
    write(file, "2\n");
    expect(mini.sink.of("files.edit")[0]?.agent).toEqual(UNKNOWN_AGENT);
    sessions = [session({ id: "s-chat", projectPath: dir })];
    presence.observe({ kind: "conversation", sessionId: "s-chat", appended: [toolRow("write", { path: file, content: "3\n" })] });
    write(file, "3\n");
    expect(mini.sink.of("files.edit")[1]?.agent).toEqual({ name: "Eva", color: "#8b5cf6", sessionId: "s-chat" });
    clock.advance(CLAIM_MS + 1);
    write(file, "4\n");
    expect(mini.sink.of("files.edit")[2]?.agent).toEqual(UNKNOWN_AGENT);
  });

  it("ignores reads and other tools, Isaac's own save, and sockets without the file open", () => {
    const file = join(dir, "y.txt");
    writeFileSync(file, "a\n");
    const mini = client("mini");
    const book = client("macbook");
    presence.open(mini, [file]);
    presence.open(book, []);
    sessions = [session({ id: "s", projectPath: dir })];
    presence.observe({ kind: "conversation", sessionId: "s", appended: [toolRow("read", { path: "y.txt" })] });
    presence.saved(file, sha1("mine\n"));
    write(file, "mine\n");
    expect(mini.sink.of("files.edit")).toEqual([]);
    write(file, "theirs\n");
    expect(mini.sink.of("files.edit")).toHaveLength(1);
    expect(mini.sink.of("files.edit")[0]?.agent).toEqual(UNKNOWN_AGENT);
    expect(book.sink.of("files.edit")).toEqual([]);
  });

  it("stops watching a folder when its last open file closes, and reads a reopened file fresh", () => {
    const file = join(dir, "z.txt");
    writeFileSync(file, "a\n");
    const mini = client("mini");
    presence.open(mini, [file]);
    expect(watchers.has(dir)).toBe(true);
    presence.open(mini, []);
    expect(watchers.has(dir)).toBe(false);
    writeFileSync(file, "b\n");
    presence.open(mini, [file]);
    write(file, "b\n");
    expect(mini.sink.of("files.edit")).toEqual([]);
    presence.drop(mini.sink);
    expect(watchers.has(dir)).toBe(false);
  });

  it("relays Isaac's caret to every other device, newest first, and drops it with its socket", () => {
    const mini = client("mini");
    const book = client("macbook");
    presence.open(mini, []);
    presence.open(book, []);
    expect(book.sink.of("files.presence")).toEqual([{ t: "files.presence", focus: [] }]);
    const focus = { path: "/Users/ike/Eva/memory/prime.md", caret: { line: 12, column: 3 }, selection: { start: { line: 12, column: 3 }, end: { line: 14, column: 1 } }, selectedText: "two\nlines" };
    presence.caret(book, focus);
    expect(mini.sink.of("files.presence").at(-1)).toEqual({ t: "files.presence", focus: [{ ...focus, device: "macbook", deviceName: "macbook name", at: clock.t }] });
    expect(book.sink.of("files.presence")).toHaveLength(1);
    presence.drop(book.sink);
    expect(mini.sink.of("files.presence").at(-1)).toEqual({ t: "files.presence", focus: [] });
  });
});

describe("toolCallOf", () => {
  it("names the files an editing call writes and nothing for other tools", () => {
    expect(toolCallOf("edit", { i: "Fixing", input: "[apps/a.ts#1A2B]\nPUT 1:\n+x\n[b dir/c.md#FFFF]\nCUT 2" })).toEqual({ name: "edit", summary: "Fixing", paths: ["apps/a.ts", "b dir/c.md"] });
    expect(toolCallOf("write", { path: "/abs/new.ts", content: "x" }).paths).toEqual(["/abs/new.ts"]);
    expect(toolCallOf("Edit", { file_path: "/abs/e.ts", old_string: "a", new_string: "b" }).paths).toEqual(["/abs/e.ts"]);
    expect(toolCallOf("apply_patch", { input: "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** Add File: src/y.ts\n+c\n*** End Patch" }).paths).toEqual(["src/x.ts", "src/y.ts"]);
    expect(toolCallOf("write", { path: "local://notes.md", content: "x" })).toEqual({ name: "write", summary: "path=local://notes.md content=x" });
    expect(toolCallOf("read", { path: "a.ts" })).toEqual({ name: "read", summary: "path=a.ts" });
    expect(toolCallOf("bash", null)).toEqual({ name: "bash", summary: "" });
  });
});
