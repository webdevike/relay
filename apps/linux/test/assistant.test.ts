import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentImage, AgentMessage, AgentSession, ServerMessage } from "@relay/protocol";
import type { LaunchOptions } from "../src/agents/herdr";
import { AssistantService, REGISTER_TIMEOUT_MS, SNAPSHOT_DEBOUNCE_MS, STATUS_PREFIX, toAssistantMessages } from "../src/assistant/service";
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

function harness(options: { prime?: string; remembered?: string; agentHome?: null; launchFails?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "eva-home-"));
  dirs.push(home);
  if (options.prime !== undefined) {
    mkdirSync(join(home, ".omp", "assistant"), { recursive: true });
    writeFileSync(join(home, ".omp", "assistant", "prime.md"), options.prime);
  }
  const store = new FileAssistantStore(join(home, "assistant.json"));
  if (options.remembered !== undefined) store.save({ sessionFile: options.remembered });
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
  });
  /** Eva registers: the provider lists her and reports the session change. */
  const register = (status: AgentSession["status"], sessionFile?: string): void => {
    agents.sessions = [other, eva(status)];
    if (sessionFile !== undefined) files.set("eva-1", sessionFile);
    service.observe({ kind: "sessions" });
  };
  const remembered = (): AssistantRecord | null => store.load();
  return { home, service, agents, launches, tokens, viewing, pushes, broadcasts, logs, clock, register, remembered };
}

const flush = (): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

describe("toAssistantMessages", () => {
  it("keeps user and assistant rows, turns prefixed job messages into status rows, and drops the rest", () => {
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
      { id: "j1", role: "status", text: "furry-drop finished", at: 6 },
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
    expect(h.remembered()).toEqual({ sessionFile: "/sessions/eva.jsonl" });
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

  it("remembers the session file as soon as a status report carries it", () => {
    const h = harness();
    h.register("idle");
    expect(h.remembered()).toBeNull();
    h.register("idle", "/sessions/eva.jsonl");
    expect(h.remembered()).toEqual({ sessionFile: "/sessions/eva.jsonl" });
  });
});
