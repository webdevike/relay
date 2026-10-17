import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentImage, AgentMessage, AgentSession, ServerMessage } from "@relay/protocol";
import type { LaunchOptions } from "../src/agents/herdr";
import { AssistantService, REGISTER_TIMEOUT_MS, SNAPSHOT_DEBOUNCE_MS, STATUS_PREFIX, toAssistantMessages } from "../src/assistant/service";
import { type FillSpawn, splitSignin } from "../src/assistant/signin";
import { FileAssistantStore, type AssistantRecord } from "../src/assistant/store";
import type { PushMessage } from "../src/push/notifier";
import { AckFailure, type AgentProvider } from "../src/seams";
import type { SessionClock } from "../src/session";

class FakeClock implements SessionClock {
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  private current = 1_000;
  now(): number {
    return this.current;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.current);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
  }
}

const eva = (status: AgentSession["status"]): AgentSession => ({ id: "eva-1", provider: "omp", title: "Eva", projectPath: "/home/ike/Eva", status, lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant" });
const other: AgentSession = { id: "s1", provider: "omp", title: "relay", projectPath: "/w/relay", status: "working", lastActivity: "", lastActivityAt: 2, canRespond: true, kind: "manual" };

/** Just enough of the provider: the session list, a conversation per session, and recorded replies. */
function fakeProvider(): AgentProvider & { sessions: AgentSession[]; transcript: AgentMessage[]; replies: [string, string, boolean][]; replyImages: (readonly AgentImage[] | undefined)[] } {
  const unsupported = (): never => {
    throw new Error("not used here");
  };
  return {
    id: "omp",
    isAvailable: true,
    onChange: null,
    sessions: [],
    transcript: [],
    replies: [],
    replyImages: [],
    start: () => undefined,
    conversation(sessionId) {
      return Promise.resolve(sessionId === "eva-1" ? this.transcript : null);
    },
    reply(sessionId, text, submit, images) {
      this.replies.push([sessionId, text, submit]);
      this.replyImages.push(images);
      return Promise.resolve();
    },
    launch: unsupported,
    options: unsupported,
    image: unsupported,
    configure: unsupported,
    abort: unsupported,
    end: unsupported,
    answerAsk: unsupported,
    cancelAsk: unsupported,
    pendingAsk: () => null,
    decideApproval: unsupported,
    pendingApproval: () => null,
    gate: null,
    runGate: unsupported,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes an omp session file: one `message` entry per given message. */
function transcriptFile(dir: string, name: string, messages: Record<string, unknown>[]): string {
  const file = join(dir, name);
  writeFileSync(file, messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"));
  return file;
}

/** A fake `eva-browser.ts fill`: records argv, cwd and stdin, then exits with `exit` after writing `stderr`. */
function fakeFill(outcome: { exit: number; stderr?: string } = { exit: 0 }) {
  const runs: { argv: readonly string[]; cwd: string; stdin: string }[] = [];
  const spawn: FillSpawn = (argv, cwd) => {
    const run = { argv, cwd, stdin: "" };
    runs.push(run);
    return {
      stdin: {
        write: (chunk) => {
          run.stdin += chunk;
        },
        end: () => undefined,
      },
      stderr: new Response(outcome.stderr ?? "").body ?? new ReadableStream(),
      exited: Promise.resolve(outcome.exit),
      kill: () => undefined,
    };
  };
  return { runs, spawn };
}

function harness(options: { prime?: string; remembered?: string; history?: string[]; agentHome?: null; launchFails?: boolean; fill?: { exit: number; stderr?: string } } = {}) {
  const home = mkdtempSync(join(tmpdir(), "eva-home-"));
  dirs.push(home);
  if (options.prime !== undefined) {
    mkdirSync(join(home, ".omp", "assistant"), { recursive: true });
    writeFileSync(join(home, ".omp", "assistant", "prime.md"), options.prime);
  }
  const store = new FileAssistantStore(join(home, "assistant.json"));
  if (options.remembered !== undefined || options.history !== undefined) store.save({ ...(options.remembered === undefined ? {} : { sessionFile: options.remembered }), history: options.history ?? [] });
  const agents = fakeProvider();
  const files = new Map<string, string>();
  const launches: LaunchOptions[] = [];
  const tokens = new Map([
    ["phone-1", "ExponentPushToken[one]"],
    ["phone-2", "ExponentPushToken[two]"],
  ]);
  const viewing = new Set<string>();
  const pushes: PushMessage[] = [];
  const broadcasts: ServerMessage[] = [];
  const logs: string[] = [];
  const clock = new FakeClock();
  const fill = fakeFill(options.fill);
  const service = new AssistantService({
    agents,
    launch: (launchOptions) => {
      launches.push(launchOptions);
      return options.launchFails === true ? Promise.reject(new AckFailure({ code: "agent_launch_failed", message: "herdr is not installed" })) : Promise.resolve();
    },
    sessionFile: (sessionId) => files.get(sessionId) ?? null,
    agentHome: options.agentHome === null ? null : home,
    store,
    tokens: {
      tokens: () => tokens,
      unregister: (deviceId) => {
        tokens.delete(deviceId);
      },
    },
    sender: {
      send: (messages) => {
        pushes.push(...messages);
        return Promise.resolve(messages.map(() => ({ ok: true as const })));
      },
    },
    broadcast: (message) => {
      broadcasts.push(message);
    },
    isViewing: (deviceId) => viewing.has(deviceId),
    clock,
    log: (line) => logs.push(line),
    spawn: fill.spawn,
  });
  /** Eva registers: the provider lists her and reports the session change. */
  const register = (status: AgentSession["status"], sessionFile?: string): void => {
    agents.sessions = [other, eva(status)];
    if (sessionFile !== undefined) files.set("eva-1", sessionFile);
    service.observe({ kind: "sessions" });
  };
  const remembered = (): AssistantRecord | null => store.load();
  return { home, service, agents, launches, tokens, viewing, pushes, broadcasts, logs, clock, register, remembered, fills: fill.runs };
}

const flush = (): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

describe("toAssistantMessages", () => {
  it("keeps user and assistant rows and drops tool rows, system rows, job lines and the prime", () => {
    const rows: AgentMessage[] = [
      { id: "p", role: "user", text: "You are Eva.", at: 1 },
      { id: "u1", role: "user", text: "morning", at: 2 },
      { id: "a1", role: "assistant", text: "", at: 3, streaming: true },
      { id: "t1", role: "tool", text: "ls", at: 4, tool: { name: "bash", summary: "ls" } },
      { id: "s1", role: "system", text: "injected", at: 5 },
      { id: "j1", role: "user", text: `${STATUS_PREFIX}furry-drop finished`, at: 6 },
      { id: "a2", role: "assistant", text: "The furry-drop run is done.", at: 7 },
      { id: "u2", role: "user", text: "You are Eva.", at: 8 },
    ];
    expect(toAssistantMessages(rows, "You are Eva.")).toEqual([
      { id: "u1", role: "user", text: "morning", at: 2 },
      { id: "a2", role: "assistant", text: "The furry-drop run is done.", at: 7 },
      { id: "u2", role: "user", text: "You are Eva.", at: 8 },
    ]);
    expect(toAssistantMessages(rows.slice(0, 1), null)).toEqual([{ id: "p", role: "user", text: "You are Eva.", at: 1 }]);
  });
});

describe("AssistantService snapshot", () => {
  it("is empty and idle without a live Eva, and busy with her mapped transcript while she works", async () => {
    const h = harness({ prime: "You are Eva.\n" });
    expect(await h.service.snapshot()).toEqual({ rev: 0, messages: [], busy: false, sessionId: "" });
    h.register("working");
    h.agents.transcript = [
      { id: "p", role: "user", text: "You are Eva.", at: 1 },
      { id: "u1", role: "user", text: "hi", at: 2 },
      { id: "a1", role: "assistant", text: "hello", at: 3 },
    ];
    expect(await h.service.snapshot()).toEqual({
      rev: 1,
      busy: true,
      sessionId: "eva-1",
      messages: [
        { id: "u1", role: "user", text: "hi", at: 2 },
        { id: "a1", role: "assistant", text: "hello", at: 3 },
      ],
    });
  });
});

describe("toAssistantMessages machinery", () => {
  it("hides job lines, the prime, empty replies and the silence marker, whole or streaming in", () => {
    const rows: AgentMessage[] = [
      { id: "p", role: "user", text: "You are Eva.", at: 1 },
      { id: "a0", role: "assistant", text: "", at: 2 },
      { id: "j1", role: "user", text: `${STATUS_PREFIX}Rollover: fresh context`, at: 3 },
      { id: "a1", role: "assistant", text: "(nothing to report)", at: 4 },
      { id: "a2", role: "assistant", text: "  (nothing to report)\n", at: 5 },
      { id: "a3", role: "assistant", text: "(nothing", at: 6, streaming: true },
      { id: "a4", role: "assistant", text: "(nothing to report) but wait", at: 7 },
      { id: "a5", role: "assistant", text: "(", at: 8 },
    ];
    expect(toAssistantMessages(rows, "You are Eva.")).toEqual([
      { id: "a4", role: "assistant", text: "(nothing to report) but wait", at: 7 },
      { id: "a5", role: "assistant", text: "(", at: 8 },
    ]);
  });
});

describe("toAssistantMessages images", () => {
  it("carries image refs on user and assistant rows, and keeps an image-only reply", () => {
    const ref = { id: "img-1", mimeType: "image/png" as const, width: 10, height: 20 };
    const rows: AgentMessage[] = [
      { id: "u1", role: "user", text: "", at: 1, images: [ref] },
      { id: "a1", role: "assistant", text: "", at: 2, images: [{ id: "img-2", mimeType: "image/webp" }] },
      { id: "a2", role: "assistant", text: "look", at: 3, images: [] },
    ];
    expect(toAssistantMessages(rows, null)).toEqual([
      { id: "u1", role: "user", text: "", at: 1, images: [ref] },
      { id: "a1", role: "assistant", text: "", at: 2, images: [{ id: "img-2", mimeType: "image/webp" }] },
      { id: "a2", role: "assistant", text: "look", at: 3 },
    ]);
  });

  it("snapshots the session id with the images, and a turn with images reaches the provider", async () => {
    const h = harness();
    h.register("idle");
    const image = { mimeType: "image/jpeg" as const, data: "AAAA" };
    await h.service.turn("see this", [image]);
    await h.service.turn("plain");
    expect(h.agents.replies).toEqual([
      ["eva-1", "see this", true],
      ["eva-1", "plain", true],
    ]);
    expect(h.agents.replyImages).toEqual([[image], undefined]);
    h.agents.transcript = [{ id: "u1", role: "user", text: "see this", at: 1, images: [{ id: "i1", mimeType: "image/jpeg" }] }];
    expect(await h.service.snapshot()).toMatchObject({ sessionId: "eva-1", messages: [{ id: "u1", images: [{ id: "i1", mimeType: "image/jpeg" }] }] });
  });
});

describe("AssistantService turns", () => {
  it("delivers a turn straight to a live Eva, and say() prefixes it as a job message", async () => {
    const h = harness();
    h.register("idle");
    await h.service.turn("what's up?");
    await h.service.say("furry-drop finished");
    expect(h.launches).toEqual([]);
    expect(h.agents.replies).toEqual([
      ["eva-1", "what's up?", true],
      ["eva-1", `${STATUS_PREFIX}furry-drop finished`, true],
    ]);
  });

  it("starts a new primed Eva when none is remembered and holds the turn until the prime is underway", async () => {
    const h = harness({ prime: "You are Eva.\n" });
    const turn = h.service.turn("hi");
    await flush();
    expect(h.launches).toEqual([{ env: { EVA_ASSISTANT: "1" }, prompt: "You are Eva." }]);
    h.register("idle", "/sessions/eva.jsonl");
    await flush();
    expect(h.agents.replies).toEqual([]);
    h.register("working");
    await turn;
    expect(h.agents.replies).toEqual([["eva-1", "hi", true]]);
    expect(h.remembered()).toEqual({ sessionFile: "/sessions/eva.jsonl", history: [] });
  });

  it("resumes the remembered transcript when its file still exists, with no prime, as soon as Eva registers", async () => {
    const sessions = mkdtempSync(join(tmpdir(), "eva-sessions-"));
    dirs.push(sessions);
    const file = join(sessions, "eva.jsonl");
    writeFileSync(file, "");
    const h = harness({ prime: "You are Eva.", remembered: file });
    const turn = h.service.turn("back?");
    await flush();
    expect(h.launches).toEqual([{ env: { EVA_ASSISTANT: "1" }, resume: file }]);
    h.register("idle", file);
    await turn;
    expect(h.agents.replies).toEqual([["eva-1", "back?", true]]);
  });

  it("starts fresh when the remembered file is gone, and shares one launch between concurrent turns", async () => {
    const h = harness({ remembered: "/nowhere/eva.jsonl" });
    const first = h.service.turn("one");
    const second = h.service.turn("two");
    await flush();
    expect(h.launches).toEqual([{ env: { EVA_ASSISTANT: "1" } }]);
    h.register("idle");
    await Promise.all([first, second]);
    expect(h.agents.replies.map(([, text]) => text)).toEqual(["one", "two"]);
  });

  it("fails the turn without an agent home, when the launch fails, or when Eva never registers", async () => {
    await expect(harness({ agentHome: null }).service.turn("hi")).rejects.toMatchObject({ error: { code: "agent_launch_failed" } });
    await expect(harness({ launchFails: true }).service.turn("hi")).rejects.toMatchObject({ error: { code: "agent_launch_failed", message: "herdr is not installed" } });
    const h = harness();
    const turn = h.service.turn("hi");
    await flush();
    h.clock.advance(REGISTER_TIMEOUT_MS);
    await expect(turn).rejects.toMatchObject({ error: { code: "agent_launch_failed" } });
    expect(h.agents.replies).toEqual([]);
  });
});

describe("AssistantService changes", () => {
  it("broadcasts one debounced snapshot per burst of changes to Eva's session, none for other sessions", async () => {
    const h = harness();
    h.register("working");
    h.agents.transcript = [{ id: "u1", role: "user", text: "hi", at: 1 }];
    h.service.observe({ kind: "conversation", sessionId: "eva-1", appended: [{ id: "u1", role: "user", text: "hi", at: 1 }] });
    h.service.observe({ kind: "message", sessionId: "eva-1", id: "a1", text: "hel", streaming: true });
    h.service.observe({ kind: "conversation", sessionId: "s1", appended: [{ id: "x", role: "user", text: "other", at: 1 }] });
    h.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(h.broadcasts).toEqual([{ t: "assistant.snapshot", snapshot: { rev: 3, busy: true, sessionId: "eva-1", messages: [{ id: "u1", role: "user", text: "hi", at: 1 }] } }]);
    h.service.observe({ kind: "sessions" }); // nothing about Eva changed
    h.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(h.broadcasts).toHaveLength(1);
  });

  it("pushes each settled reply to the phones not viewing the thread, never a streaming one", async () => {
    const h = harness();
    h.register("working");
    h.viewing.add("phone-2");
    h.service.observe({ kind: "conversation", sessionId: "eva-1", appended: [{ id: "a1", role: "assistant", text: "", at: 1, streaming: true }] });
    h.service.observe({ kind: "message", sessionId: "eva-1", id: "a1", text: "On it", streaming: true });
    expect(h.pushes).toEqual([]);
    h.service.observe({ kind: "message", sessionId: "eva-1", id: "a1", text: "On it, the run finished fine.", streaming: false });
    h.service.observe({ kind: "message", sessionId: "eva-1", id: "a2", text: "", streaming: false });
    h.service.observe({ kind: "conversation", sessionId: "eva-1", appended: [{ id: "a3", role: "assistant", text: "x".repeat(200), at: 2 }] });
    await flush();
    expect(h.pushes.map((push) => [push.to, push.title, push.body, push.data, push.interruptionLevel])).toEqual([
      ["ExponentPushToken[one]", "Eva", "On it, the run finished fine.", { assistant: true }, undefined],
      ["ExponentPushToken[one]", "Eva", `${"x".repeat(179)}…`, { assistant: true }, undefined],
    ]);
  });

  it("remembers the session file as soon as a status report carries it, keeping the history", () => {
    const h = harness({ history: ["/sessions/old.jsonl"] });
    h.register("idle");
    expect(h.remembered()).toEqual({ history: ["/sessions/old.jsonl"] });
    h.register("idle", "/sessions/eva.jsonl");
    expect(h.remembered()).toEqual({ sessionFile: "/sessions/eva.jsonl", history: ["/sessions/old.jsonl"] });
  });

  it("never pushes the silence marker", async () => {
    const h = harness();
    h.register("working");
    h.service.observe({ kind: "message", sessionId: "eva-1", id: "a1", text: "(nothing to report)", streaming: false });
    h.service.observe({ kind: "conversation", sessionId: "eva-1", appended: [{ id: "a2", role: "assistant", text: " (nothing to report)\n", at: 1 }] });
    await flush();
    expect(h.pushes).toEqual([]);
  });
});

describe("AssistantService earlier contexts", () => {
  it("shows each history transcript in order, then the live session, with unique ids and the machinery filtered out", async () => {
    const h = harness({ prime: "You are Eva." });
    const first = transcriptFile(h.home, "2026-10-14T0400_aaaa.jsonl", [
      { role: "user", content: "You are Eva.", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "thread.md" } }], timestamp: 2 },
      { role: "user", content: "morning", timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "Morning." }], timestamp: 4 },
      { role: "user", content: `${STATUS_PREFIX}Heartbeat: 1 new.`, timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "(nothing to report)" }], timestamp: 6 },
    ]);
    const second = transcriptFile(h.home, "2026-10-15T0400_bbbb.jsonl", [
      { role: "user", content: "You are Eva.\n\nAn older second paragraph.", timestamp: 10 },
      { role: "user", content: "again", timestamp: 11 },
      { role: "assistant", content: [{ type: "text", text: "Hi again." }], timestamp: 12 },
    ]);
    new FileAssistantStore(join(h.home, "assistant.json")).save({ sessionFile: "/sessions/live.jsonl", history: [first, second] });
    h.register("idle", "/sessions/live.jsonl");
    h.agents.transcript = [
      { id: "p", role: "user", text: "You are Eva.", at: 20 },
      { id: "a0", role: "assistant", text: "", at: 21 },
      { id: "u1", role: "user", text: "live", at: 22 },
    ];
    const snapshot = await h.service.snapshot();
    expect(snapshot.messages).toEqual([
      { id: "2026-10-14T0400_aaaa-3", role: "user", text: "morning", at: 3 },
      { id: "2026-10-14T0400_aaaa-4", role: "assistant", text: "Morning.", at: 4 },
      { id: "2026-10-15T0400_bbbb-2", role: "user", text: "again", at: 11 },
      { id: "2026-10-15T0400_bbbb-3", role: "assistant", text: "Hi again.", at: 12 },
      { id: "u1", role: "user", text: "live", at: 22 },
    ]);
    expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(snapshot.messages.length);
  });

  it("keeps the history through a rollover (no live session, no session file) and rereads a transcript that grew", async () => {
    const h = harness();
    const file = transcriptFile(h.home, "2026-10-14T0400_aaaa.jsonl", [{ role: "user", content: "one", timestamp: 1 }]);
    new FileAssistantStore(join(h.home, "assistant.json")).save({ history: [file] });
    expect(await h.service.snapshot()).toEqual({ rev: 0, busy: false, sessionId: "", messages: [{ id: "2026-10-14T0400_aaaa-1", role: "user", text: "one", at: 1 }] });
    transcriptFile(h.home, "2026-10-14T0400_aaaa.jsonl", [
      { role: "user", content: "one", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2 },
    ]);
    expect((await h.service.snapshot()).messages.map((message) => message.text)).toEqual(["one", "two"]);
  });

  it("starts a new primed session after a rollover and keeps the history in assistant.json", async () => {
    const h = harness({ prime: "You are Eva.", history: ["/sessions/old.jsonl"] });
    const turn = h.service.turn("hi");
    await flush();
    expect(h.launches).toEqual([{ env: { EVA_ASSISTANT: "1" }, prompt: "You are Eva." }]);
    h.register("idle", "/sessions/new.jsonl");
    h.register("working");
    await turn;
    expect(h.remembered()).toEqual({ sessionFile: "/sessions/new.jsonl", history: ["/sessions/old.jsonl"] });
  });

  it("shows the transcript a restart will resume while no session is live, and leaves it out of the history once live", async () => {
    const h = harness();
    const file = transcriptFile(h.home, "2026-10-16T0400_cccc.jsonl", [{ role: "user", content: "kept", timestamp: 1 }]);
    new FileAssistantStore(join(h.home, "assistant.json")).save({ sessionFile: file, history: [file] });
    expect((await h.service.snapshot()).messages.map((message) => message.text)).toEqual(["kept"]);
    h.register("idle", file);
    h.agents.transcript = [{ id: "u1", role: "user", text: "kept", at: 1 }];
    expect((await h.service.snapshot()).messages).toEqual([{ id: "u1", role: "user", text: "kept", at: 1 }]);
  });

  it("reads an assistant.json from before the history field as empty history", () => {
    const h = harness();
    writeFileSync(join(h.home, "assistant.json"), JSON.stringify({ sessionFile: "/sessions/eva.jsonl" }));
    expect(h.remembered()).toEqual({ sessionFile: "/sessions/eva.jsonl", history: [] });
  });
});

describe("sign-in token", () => {
  it("strips the token from a reply and carries url and host", () => {
    expect(splitSignin("Sign in to GitHub.\n[[signin:https://github.com/login]]", false)).toEqual({
      text: "Sign in to GitHub.",
      signin: { url: "https://github.com/login", host: "github.com" },
    });
    expect(splitSignin("[[signin:http://localhost:3000/x?a=1]]\n", false)).toEqual({ text: "", signin: { url: "http://localhost:3000/x?a=1", host: "localhost" } });
  });

  it("cuts a token that is not an http(s) url without a card, and leaves a token in mid-text alone", () => {
    expect(splitSignin("hi [[signin:javascript:alert(1)]]", false)).toEqual({ text: "hi" });
    expect(splitSignin("hi [[signin:not a url]]", false)).toEqual({ text: "hi [[signin:not a url]]" });
    expect(splitSignin("[[signin:https://a.com]] then more", false)).toEqual({ text: "[[signin:https://a.com]] then more" });
  });

  it("hides a token that is still streaming in, but not other text", () => {
    for (const partial of ["Sign in.\n[", "Sign in.\n[[", "Sign in.\n[[sig", "Sign in.\n[[signin:", "Sign in.\n[[signin:https://git"]) {
      expect(splitSignin(partial, true)).toEqual({ text: "Sign in." });
      expect(splitSignin(partial, false)).toEqual({ text: partial });
    }
    expect(splitSignin("array[[0]] is", true)).toEqual({ text: "array[[0]] is" });
    expect(splitSignin("done\n[[signin:https://github.com/login]]", true).signin?.host).toBe("github.com");
  });

  it("shows the card on the assistant row and leaves a reply that is only the token", () => {
    const rows: AgentMessage[] = [
      { id: "a1", role: "assistant", text: "Please sign in.\n[[signin:https://github.com/login]]", at: 1 },
      { id: "a2", role: "assistant", text: "[[", at: 2, streaming: true },
      { id: "a3", role: "assistant", text: "[[signin:https://x.org/in]]", at: 3 },
    ];
    expect(toAssistantMessages(rows, null)).toEqual([
      { id: "a1", role: "assistant", text: "Please sign in.", at: 1, signin: { url: "https://github.com/login", host: "github.com" } },
      { id: "a3", role: "assistant", text: "", at: 3, signin: { url: "https://x.org/in", host: "x.org" } },
    ]);
  });

  it("pushes a sign-in reply without the token", async () => {
    const h = harness();
    h.register("working");
    h.service.observe({ kind: "conversation", sessionId: "eva-1", appended: [{ id: "a1", role: "assistant", text: "Sign in please.\n[[signin:https://github.com/login]]", at: 1 }] });
    await flush();
    expect(h.pushes.map((push) => push.body)).toEqual(["Sign in please.", "Sign in please."]);
  });
});

describe("AssistantService signin", () => {
  const signinRow: AgentMessage = { id: "a1", role: "assistant", text: "Please sign in.\n[[signin:https://github.com/login]]", at: 1 };

  it("runs the browser tool with the credentials on stdin only, marks the message submitted and tells Eva", async () => {
    const h = harness();
    h.register("idle");
    h.agents.transcript = [signinRow];
    await h.service.signin("a1", "https://github.com/login", "isaac", "hunter2");
    expect(h.fills).toHaveLength(1);
    expect(h.fills[0]?.argv).toEqual(["bun", join(h.home, ".omp", "tools", "eva-browser.ts"), "fill", "https://github.com/login"]);
    expect(h.fills[0]?.cwd).toBe(h.home);
    expect(JSON.parse(h.fills[0]?.stdin ?? "")).toEqual({ username: "isaac", password: "hunter2" });
    expect(h.fills[0]?.argv.join(" ")).not.toContain("hunter2");
    await flush();
    expect(h.agents.replies).toEqual([["eva-1", `${STATUS_PREFIX}Credentials submitted for github.com in your browser tab; continue there.`, true]]);
    expect(h.logs.join("\n")).not.toContain("hunter2");
    expect(h.logs.join("\n")).not.toContain("isaac");
    const snapshot = await h.service.snapshot();
    expect(snapshot.messages).toEqual([
      { id: "a1", role: "assistant", text: "Please sign in.", at: 1, signin: { url: "https://github.com/login", host: "github.com", submitted: true } },
    ]);
  });

  it("broadcasts a snapshot that carries submitted", async () => {
    const h = harness();
    h.register("idle");
    h.agents.transcript = [signinRow];
    await h.service.signin("a1", "https://github.com/login", "isaac", "hunter2");
    h.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    const frame = h.broadcasts.at(-1);
    expect(frame?.t === "assistant.snapshot" ? frame.snapshot.messages[0]?.signin?.submitted : null).toBe(true);
  });

  it("nacks with the tool's last stderr line and leaves the message unsubmitted", async () => {
    const h = harness({ fill: { exit: 1, stderr: "warming up\nIncorrect password.\n" } });
    h.register("idle");
    h.agents.transcript = [signinRow];
    await expect(h.service.signin("a1", "https://github.com/login", "isaac", "nope")).rejects.toMatchObject({
      error: { code: "invalid_command", message: "Incorrect password." },
    });
    await flush();
    expect(h.agents.replies).toEqual([]);
    expect((await h.service.snapshot()).messages[0]?.signin?.submitted).toBeUndefined();
    expect(h.logs.join("\n")).not.toContain("nope");
  });

  it("names the exit code when the tool says nothing, and refuses a url that is not http(s) or a host without an agent home", async () => {
    const h = harness({ fill: { exit: 3 } });
    await expect(h.service.signin("a1", "https://github.com/login", "u", "p")).rejects.toMatchObject({ error: { code: "invalid_command", message: "eva-browser fill exited 3" } });
    await expect(h.service.signin("a1", "file:///etc/passwd", "u", "p")).rejects.toMatchObject({ error: { code: "invalid_command" } });
    expect(h.fills).toHaveLength(1);
    await expect(harness({ agentHome: null }).service.signin("a1", "https://github.com/login", "u", "p")).rejects.toMatchObject({ error: { code: "agent_launch_failed" } });
  });
});
