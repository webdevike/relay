import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentImage, AgentMessage, AgentSession, AssistantMessage, ServerMessage } from "@relay/protocol";
import type { LaunchOptions } from "../src/agents/herdr";
import { loadRegistry } from "../src/assistant/registry";
import { handleAssistantSay } from "../src/assistant/http";
import { assistantStatus, AssistantService, AssistantThreads, lastReplyOf, MAX_LAST_REPLY, REGISTER_TIMEOUT_MS, SNAPSHOT_DEBOUNCE_MS, statusPrefix, toAssistantMessages } from "../src/assistant/service";
import { type FillSpawn, splitSignin } from "../src/assistant/signin";
import { defaultAssistantPath, FileAssistantStore, type AssistantRecord } from "../src/assistant/store";
import { voiceTurn } from "../src/assistant/voice";
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

const ASTRA = { id: "astra", title: "Astra" };
const NOVA = { id: "nova", title: "Nova" };
const STATUS_PREFIX = statusPrefix("Astra");
const ASTRA_ENV = { env: { RELAY_ASSISTANT: "astra", RELAY_ASSISTANT_TITLE: "Astra" }, label: "Astra" };
const astra = (status: AgentSession["status"]): AgentSession => ({ id: "eva-1", provider: "omp", title: "Astra", projectPath: "/home/ike/Eva", status, lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant", assistant: "astra" });
const nova = (status: AgentSession["status"]): AgentSession => ({ id: "nova-1", provider: "omp", title: "Nova", projectPath: "/home/ike/Eva", status, lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant", assistant: "nova" });
const other: AgentSession = { id: "s1", provider: "omp", title: "relay", projectPath: "/w/relay", status: "working", lastActivity: "", lastActivityAt: 2, canRespond: true, kind: "manual" };

/** Just enough of the provider: the session list, a conversation per session, and recorded replies. */
type FakeProvider = AgentProvider & { sessions: AgentSession[]; transcript: AgentMessage[]; novaTranscript: AgentMessage[]; replies: [string, string, boolean][]; replyImages: (readonly AgentImage[] | undefined)[] };

function fakeProvider(): FakeProvider {
  const unsupported = (): never => {
    throw new Error("not used here");
  };
  return {
    id: "omp",
    isAvailable: true,
    onChange: null,
    sessions: [],
    transcript: [],
    novaTranscript: [],
    replies: [],
    replyImages: [],
    start: () => undefined,
    conversation(sessionId) {
      return Promise.resolve(sessionId === "eva-1" ? this.transcript : sessionId === "nova-1" ? this.novaTranscript : null);
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

/** What a second harness shares with the first: agent home, provider, phones and the push recorder. */
interface Shared {
  readonly home: string;
  readonly agents: FakeProvider;
  readonly files: Map<string, string>;
  readonly tokens: Map<string, string>;
  readonly pushes: PushMessage[];
  readonly clock: FakeClock;
}

interface HarnessOptions {
  agent?: { id: string; title: string; scope?: string };
  /** Run beside another harness's thread. */
  beside?: Shared;
  prime?: string;
  remembered?: string;
  history?: string[];
  agentHome?: null;
  launchFails?: boolean;
  fill?: { exit: number; stderr?: string };
}

function harness(options: HarnessOptions = {}) {
  const agent = options.agent ?? ASTRA;
  const beside = options.beside;
  const home = beside?.home ?? mkdtempSync(join(tmpdir(), "eva-home-"));
  if (beside === undefined) dirs.push(home);
  if (options.prime !== undefined) {
    mkdirSync(join(home, ".omp", "assistant", "agents", agent.id), { recursive: true });
    writeFileSync(join(home, ".omp", "assistant", "agents", agent.id, "prime.md"), options.prime);
  }
  const storePath = join(home, `${agent.id}.json`);
  const store = new FileAssistantStore(storePath);
  if (options.remembered !== undefined || options.history !== undefined) store.save({ ...(options.remembered === undefined ? {} : { sessionFile: options.remembered }), history: options.history ?? [] });
  const agents = beside?.agents ?? fakeProvider();
  const files = beside?.files ?? new Map<string, string>();
  const launches: LaunchOptions[] = [];
  const tokens = beside?.tokens ?? new Map([
    ["phone-1", "ExponentPushToken[one]"],
    ["phone-2", "ExponentPushToken[two]"],
  ]);
  const viewing = new Set<string>();
  const pushes: PushMessage[] = beside?.pushes ?? [];
  const broadcasts: ServerMessage[] = [];
  const logs: string[] = [];
  const clock = beside?.clock ?? new FakeClock();
  const fill = fakeFill(options.fill);
  const service = new AssistantService({
    agent,
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
  /** The agent registers: the provider lists its session (beside the others already listed) and reports the change. */
  const register = (status: AgentSession["status"], sessionFile?: string): void => {
    const session = agent.id === "nova" ? nova(status) : astra(status);
    agents.sessions = [...agents.sessions.filter((listed) => listed.id !== session.id && listed.id !== other.id), other, session];
    if (sessionFile !== undefined) files.set(session.id, sessionFile);
    service.observe({ kind: "sessions" });
  };
  const remembered = (): AssistantRecord | null => store.load();
  return { home, storePath, service, agents, files, launches, tokens, viewing, pushes, broadcasts, logs, clock, register, remembered, fills: fill.runs };
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
      { id: "p", role: "user", text: "You are Astra.", at: 1 },
      { id: "u1", role: "user", text: "morning", at: 2 },
      { id: "a1", role: "assistant", text: "", at: 3, streaming: true },
      { id: "t1", role: "tool", text: "ls", at: 4, tool: { name: "bash", summary: "ls" } },
      { id: "s1", role: "system", text: "injected", at: 5 },
      { id: "j1", role: "user", text: `${STATUS_PREFIX}furry-drop finished`, at: 6 },
      { id: "a2", role: "assistant", text: "The furry-drop run is done.", at: 7 },
      { id: "u2", role: "user", text: "You are Astra.", at: 8 },
    ];
    expect(toAssistantMessages(rows, "You are Astra.", STATUS_PREFIX)).toEqual([
      { id: "u1", role: "user", text: "morning", at: 2 },
      { id: "a2", role: "assistant", text: "The furry-drop run is done.", at: 7 },
      { id: "u2", role: "user", text: "You are Astra.", at: 8 },
    ]);
    expect(toAssistantMessages(rows.slice(0, 1), null, STATUS_PREFIX)).toEqual([{ id: "p", role: "user", text: "You are Astra.", at: 1 }]);
  });

  it("hides the pre-registry Eva and Astra primes and job prefixes from stored history", () => {
    const rows: AgentMessage[] = [
      { id: "p", role: "user", text: "You are Eva, Isaac's personal assistant, in your one continuous thread with him.", at: 1 },
      { id: "j", role: "user", text: "[From Eva's background jobs] old heartbeat", at: 2 },
      { id: "k", role: "user", text: "[From Astra's background jobs] old heartbeat", at: 3 },
      { id: "u", role: "user", text: "hello Astra", at: 4 },
    ];
    expect(toAssistantMessages(rows, "You are Astra, for eCard Systems work.\n", STATUS_PREFIX)).toEqual([{ id: "u", role: "user", text: "hello Astra", at: 4 }]);
    const astraPrime: AgentMessage = { id: "p", role: "user", text: "You are Astra, Isaac's personal assistant, in your one continuous thread with him.", at: 1 };
    expect(toAssistantMessages([astraPrime, ...rows.slice(1)], "You are Nova.", statusPrefix("Nova"))).toEqual([{ id: "u", role: "user", text: "hello Astra", at: 4 }]);
  });

  it("hides each agent's own job prefix", () => {
    const rows: AgentMessage[] = [
      { id: "j", role: "user", text: "[From Nova's background jobs] Gmail: 2 new", at: 1 },
      { id: "u", role: "user", text: "hi Nova", at: 2 },
    ];
    expect(toAssistantMessages(rows, null, statusPrefix("Nova"))).toEqual([{ id: "u", role: "user", text: "hi Nova", at: 2 }]);
  });

  it("shows a call's turns as Isaac's words marked voice, and a reply's details marker as a paragraph break", () => {
    const rows: AgentMessage[] = [
      { id: "u1", role: "user", text: voiceTurn("what time is it"), at: 1 },
      { id: "a1", role: "assistant", text: "It's 4:30.\n[[details]]\nNext up: standup at 5.", at: 2 },
      { id: "u2", role: "user", text: "typed one", at: 3 },
    ];
    expect(toAssistantMessages(rows, null, STATUS_PREFIX)).toEqual([
      { id: "u1", role: "user", text: "what time is it", at: 1, voice: true },
      { id: "a1", role: "assistant", text: "It's 4:30.\n\nNext up: standup at 5.", at: 2 },
      { id: "u2", role: "user", text: "typed one", at: 3 },
    ]);
  });
});

describe("AssistantService snapshot", () => {
  it("is empty and idle without a live Astra, and busy with her mapped transcript while she works", async () => {
    const h = harness({ prime: "You are Astra.\n" });
    expect(await h.service.snapshot()).toEqual({ rev: 0, messages: [], busy: false, sessionId: "" });
    h.register("working");
    h.agents.transcript = [
      { id: "p", role: "user", text: "You are Astra.", at: 1 },
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

  it("ignores assistant sessions of other agents and ones that name no agent (the pre-registry markers)", async () => {
    const h = harness({ prime: "You are Astra.\n" });
    h.agents.sessions = [nova("working"), { ...other, id: "old", title: "Astra", kind: "assistant" }];
    h.service.observe({ kind: "sessions" });
    expect(await h.service.snapshot()).toEqual({ rev: 0, messages: [], busy: false, sessionId: "" });
  });
});

describe("several agents", () => {
  it("keep separate snapshots, stores, primes and launches", async () => {
    const a = harness({ prime: "You are Astra." });
    const n = harness({ agent: NOVA, beside: a, prime: "You are Nova." });
    const astraTurn = a.service.turn("ECS standup?");
    const novaTurn = n.service.turn("groceries");
    await flush();
    expect(a.launches).toEqual([{ ...ASTRA_ENV, prompt: "You are Astra." }]);
    expect(n.launches).toEqual([{ env: { RELAY_ASSISTANT: "nova", RELAY_ASSISTANT_TITLE: "Nova" }, label: "Nova", prompt: "You are Nova." }]);
    a.register("working", "/sessions/astra.jsonl");
    n.service.observe({ kind: "sessions" });
    n.register("working", "/sessions/nova.jsonl");
    a.service.observe({ kind: "sessions" });
    await Promise.all([astraTurn, novaTurn]);
    expect(a.agents.replies).toEqual([
      ["eva-1", "ECS standup?", true],
      ["nova-1", "groceries", true],
    ]);
    a.agents.transcript = [{ id: "u1", role: "user", text: "ECS standup?", at: 1 }];
    a.agents.novaTranscript = [
      { id: "p", role: "user", text: "You are Nova.", at: 1 },
      { id: "u2", role: "user", text: "groceries", at: 2 },
    ];
    expect(await a.service.snapshot()).toMatchObject({ sessionId: "eva-1", messages: [{ id: "u1", text: "ECS standup?" }] });
    expect(await n.service.snapshot()).toMatchObject({ sessionId: "nova-1", messages: [{ id: "u2", text: "groceries" }] });
    expect(a.storePath).not.toBe(n.storePath);
    expect(a.remembered()).toEqual({ sessionFile: "/sessions/astra.jsonl", history: [] });
    expect(n.remembered()).toEqual({ sessionFile: "/sessions/nova.jsonl", history: [] });
  });

  it("broadcast only their own session's changes, under their own agent id", async () => {
    const a = harness();
    const n = harness({ agent: NOVA, beside: a });
    a.register("idle");
    n.register("working");
    a.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    a.broadcasts.length = 0;
    n.broadcasts.length = 0;
    a.agents.novaTranscript = [{ id: "u1", role: "user", text: "hi", at: 1 }];
    const change = { kind: "conversation", sessionId: "nova-1", appended: [{ id: "u1", role: "user", text: "hi", at: 1 }] } as const;
    a.service.observe(change);
    n.service.observe(change);
    a.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(a.broadcasts).toEqual([]);
    expect(n.broadcasts).toEqual([{ t: "assistant.snapshot", agent: "nova", snapshot: { rev: 2, busy: true, sessionId: "nova-1", messages: [{ id: "u1", role: "user", text: "hi", at: 1 }] } }]);
  });

  it("push with their own title and agent id, skipping phones viewing that agent only", async () => {
    const a = harness();
    const n = harness({ agent: NOVA, beside: a });
    a.register("working");
    n.register("working");
    n.viewing.add("phone-1");
    const reply = (sessionId: string, text: string) => ({ kind: "conversation", sessionId, appended: [{ id: `${sessionId}-a`, role: "assistant", text, at: 1 }] }) as const;
    for (const service of [a.service, n.service]) {
      service.observe(reply("eva-1", "PR #12 needs review"));
      service.observe(reply("nova-1", "Milk is out"));
    }
    await flush();
    expect(a.pushes.map((push) => [push.to, push.title, push.body, push.data])).toEqual([
      ["ExponentPushToken[one]", "Astra", "PR #12 needs review", { assistant: true, agent: "astra" }],
      ["ExponentPushToken[two]", "Astra", "PR #12 needs review", { assistant: true, agent: "astra" }],
      ["ExponentPushToken[two]", "Nova", "Milk is out", { assistant: true, agent: "nova" }],
    ]);
  });

  it("route by id, with the first registry agent as the default", () => {
    const a = harness();
    const n = harness({ agent: NOVA, beside: a });
    const threads = new AssistantThreads([a.service, n.service]);
    expect(threads.thread(undefined)).toBe(a.service);
    expect(threads.thread("nova")).toBe(n.service);
    expect(threads.thread("eva")).toBeUndefined();
  });
});

describe("POST /assistant/say", () => {
  const say = (threads: AssistantThreads, query: string, body = "furry-drop finished", remote = "127.0.0.1") =>
    handleAssistantSay(threads, new Request(`http://127.0.0.1/assistant/say${query}`, { method: "POST", body, headers: { "content-type": "text/plain" } }), remote);

  it("hands the text to the named agent as a job line", async () => {
    const a = harness();
    const n = harness({ agent: NOVA, beside: a });
    a.register("idle");
    n.register("idle");
    const response = await say(new AssistantThreads([a.service, n.service]), "?agent=nova");
    expect(response.status).toBe(200);
    expect(a.agents.replies).toEqual([["nova-1", `${statusPrefix("Nova")}furry-drop finished`, true]]);
  });

  it("is a 400 for a missing or unknown agent, never the default, and loopback only", async () => {
    const a = harness();
    a.register("idle");
    const threads = new AssistantThreads([a.service]);
    for (const query of ["", "?agent=", "?agent=nova"]) expect((await say(threads, query)).status).toBe(400);
    expect((await say(threads, "?agent=astra", "x", "192.168.1.9")).status).toBe(403);
    expect((await say(threads, "?agent=astra", "  ")).status).toBe(400);
    expect((await handleAssistantSay(null, new Request("http://127.0.0.1/assistant/say?agent=astra", { method: "POST", body: "x" }), "127.0.0.1")).status).toBe(404);
    expect(a.agents.replies).toEqual([]);
  });
});

describe("registry and store paths", () => {
  it("reads agents in file order and rejects a missing file, bad ids, duplicates and an empty list", () => {
    const home = mkdtempSync(join(tmpdir(), "eva-home-"));
    dirs.push(home);
    expect(() => loadRegistry(home)).toThrow(/cannot read/);
    mkdirSync(join(home, ".omp", "assistant"), { recursive: true });
    const write = (value: unknown): void => {
      writeFileSync(join(home, ".omp", "assistant", "agents.json"), JSON.stringify(value));
    };
    write({ agents: [{ id: "astra", title: "Astra", scope: "eCard Systems work" }, { id: "nova", title: "Nova", scope: "Personal" }] });
    expect(loadRegistry(home)).toEqual([{ ...ASTRA, scope: "eCard Systems work" }, { ...NOVA, scope: "Personal" }]);
    write({ agents: [{ id: "astra", title: "Astra", scope: "  " }, { id: "nova", title: "Nova" }] });
    expect(loadRegistry(home)).toEqual([ASTRA, NOVA]);
    for (const bad of [{ agents: [] }, { agents: [{ id: "Astra", title: "Astra" }] }, { agents: [ASTRA, { id: "astra", title: "Again" }] }, { agents: [{ id: "nova", title: " " }] }]) {
      write(bad);
      expect(() => loadRegistry(home)).toThrow(/invalid/);
    }
  });

  it("keeps one store file per agent under relay/assistants", () => {
    const saved = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = "/cfg";
    try {
      expect(defaultAssistantPath("nova")).toBe("/cfg/relay/assistants/nova.json");
    } finally {
      if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = saved;
    }
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
    expect(toAssistantMessages(rows, "You are Eva.", STATUS_PREFIX)).toEqual([
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
    expect(toAssistantMessages(rows, null, STATUS_PREFIX)).toEqual([
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
    expect(h.launches).toEqual([{ ...ASTRA_ENV, prompt: "You are Eva." }]);
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
    expect(h.launches).toEqual([{ ...ASTRA_ENV, resume: file }]);
    h.register("idle", file);
    await turn;
    expect(h.agents.replies).toEqual([["eva-1", "back?", true]]);
  });

  it("starts fresh when the remembered file is gone, and shares one launch between concurrent turns", async () => {
    const h = harness({ remembered: "/nowhere/eva.jsonl" });
    const first = h.service.turn("one");
    const second = h.service.turn("two");
    await flush();
    expect(h.launches).toEqual([ASTRA_ENV]);
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
    expect(h.broadcasts).toEqual([{ t: "assistant.snapshot", agent: "astra", snapshot: { rev: 3, busy: true, sessionId: "eva-1", messages: [{ id: "u1", role: "user", text: "hi", at: 1 }] } }]);
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
      ["ExponentPushToken[one]", "Astra", "On it, the run finished fine.", { assistant: true, agent: "astra" }, undefined],
      ["ExponentPushToken[one]", "Astra", `${"x".repeat(179)}…`, { assistant: true, agent: "astra" }, undefined],
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
    new FileAssistantStore(h.storePath).save({ sessionFile: "/sessions/live.jsonl", history: [first, second] });
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
    new FileAssistantStore(h.storePath).save({ history: [file] });
    expect(await h.service.snapshot()).toEqual({ rev: 0, busy: false, sessionId: "", messages: [{ id: "2026-10-14T0400_aaaa-1", role: "user", text: "one", at: 1 }] });
    transcriptFile(h.home, "2026-10-14T0400_aaaa.jsonl", [
      { role: "user", content: "one", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2 },
    ]);
    expect((await h.service.snapshot()).messages.map((message) => message.text)).toEqual(["one", "two"]);
  });

  it("starts a new primed session after a rollover and keeps the history in the agent's store", async () => {
    const h = harness({ prime: "You are Eva.", history: ["/sessions/old.jsonl"] });
    const turn = h.service.turn("hi");
    await flush();
    expect(h.launches).toEqual([{ ...ASTRA_ENV, prompt: "You are Eva." }]);
    h.register("idle", "/sessions/new.jsonl");
    h.register("working");
    await turn;
    expect(h.remembered()).toEqual({ sessionFile: "/sessions/new.jsonl", history: ["/sessions/old.jsonl"] });
  });

  it("shows the transcript a restart will resume while no session is live, and leaves it out of the history once live", async () => {
    const h = harness();
    const file = transcriptFile(h.home, "2026-10-16T0400_cccc.jsonl", [{ role: "user", content: "kept", timestamp: 1 }]);
    new FileAssistantStore(h.storePath).save({ sessionFile: file, history: [file] });
    expect((await h.service.snapshot()).messages.map((message) => message.text)).toEqual(["kept"]);
    h.register("idle", file);
    h.agents.transcript = [{ id: "u1", role: "user", text: "kept", at: 1 }];
    expect((await h.service.snapshot()).messages).toEqual([{ id: "u1", role: "user", text: "kept", at: 1 }]);
  });

  it("reads a store file without the history field as empty history", () => {
    const h = harness();
    writeFileSync(h.storePath, JSON.stringify({ sessionFile: "/sessions/eva.jsonl" }));
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
    expect(toAssistantMessages(rows, null, STATUS_PREFIX)).toEqual([
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

describe("assistantStatus", () => {
  it("maps the live session the way EvaOS does, and no session to not_started", () => {
    expect(assistantStatus(undefined)).toBe("not_started");
    expect(assistantStatus(astra("working"))).toBe("working");
    expect(assistantStatus(astra("waiting"))).toBe("needs_you");
    expect(assistantStatus(astra("needs_permission"))).toBe("needs_you");
    expect(assistantStatus(astra("idle"))).toBe("idle");
    expect(assistantStatus(astra("ended"))).toBe("idle");
  });
});

describe("lastReplyOf", () => {
  const row = (id: string, role: AssistantMessage["role"], text: string, at: number, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({ id, role, text, at, ...extra });

  it("is the newest assistant row, not a later user row, with its time", () => {
    expect(lastReplyOf([row("a", "assistant", "first", 1), row("b", "assistant", "second", 2), row("c", "user", "thanks", 3)])).toEqual({ text: "second", at: 2 });
    expect(lastReplyOf([row("c", "user", "hello", 1)])).toBeNull();
    expect(lastReplyOf([])).toBeNull();
  });

  it("passes over rows with no words, and names a sign-in request by its host", () => {
    const signin = { url: "https://example.com/login", host: "example.com" };
    expect(lastReplyOf([row("a", "assistant", "real", 1), row("b", "assistant", "  ", 2), row("c", "assistant", "", 3, { images: [{ id: "i", mimeType: "image/png" }] })])).toEqual({ text: "real", at: 1 });
    expect(lastReplyOf([row("a", "assistant", "", 4, { signin })])).toEqual({ text: "Sign in to example.com", at: 4 });
  });

  it("clips a long reply to the preview length with an ellipsis, and leaves a short one whole", () => {
    const long = "x".repeat(400);
    const reply = lastReplyOf([row("a", "assistant", long, 1)]);
    expect(reply?.text).toHaveLength(MAX_LAST_REPLY);
    expect(reply?.text.endsWith("…")).toBe(true);
    expect(lastReplyOf([row("a", "assistant", "y".repeat(MAX_LAST_REPLY), 1)])?.text).toBe("y".repeat(MAX_LAST_REPLY));
    // Never ends on half an emoji.
    const emoji = lastReplyOf([row("a", "assistant", `${"z".repeat(MAX_LAST_REPLY - 2)}😀😀`, 1)]);
    expect(emoji?.text).toBe(`${"z".repeat(MAX_LAST_REPLY - 2)}…`);
  });
});

describe("AssistantService listing", () => {
  it("is not_started with its scope and no reply before the agent has ever run", async () => {
    const h = harness({ agent: { ...ASTRA, scope: "eCard Systems work" } });
    expect(await h.service.listing()).toEqual({ id: "astra", title: "Astra", scope: "eCard Systems work", status: "not_started" });
    expect(await harness().service.listing()).toEqual({ id: "astra", title: "Astra", status: "not_started" });
  });

  it("is the newest settled reply of the live session with the session's status, hiding job lines, the silence marker and a reply still streaming", async () => {
    const h = harness({ prime: "You are Astra." });
    h.register("working");
    h.agents.transcript = [
      { id: "p", role: "user", text: "You are Astra.", at: 1 },
      { id: "u1", role: "user", text: "standup?", at: 2 },
      { id: "a1", role: "assistant", text: "Standup is at 9:30.", at: 3 },
      { id: "j", role: "user", text: `${STATUS_PREFIX}Heartbeat: 1 new.`, at: 4 },
      { id: "a2", role: "assistant", text: "(nothing to report)", at: 5 },
      { id: "a3", role: "assistant", text: "Drafting the", at: 6, streaming: true },
    ];
    expect(await h.service.listing()).toEqual({ id: "astra", title: "Astra", status: "working", lastReply: { text: "Standup is at 9:30.", at: 3 } });
    h.register("waiting");
    expect((await h.service.listing()).status).toBe("needs_you");
    h.register("idle");
    expect((await h.service.listing()).status).toBe("idle");
  });

  it("falls back to the earlier contexts' reply while the live session has none yet, and still shows it with no session at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eva-listing-"));
    dirs.push(dir);
    const old = transcriptFile(dir, "2026-10-14.jsonl", [
      { role: "user", content: "morning", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Morning, Isaac." }], timestamp: 2 },
    ]);
    const h = harness({ history: [old] });
    expect(await h.service.listing()).toMatchObject({ status: "not_started", lastReply: { text: "Morning, Isaac." } });
    h.register("idle", "/sessions/new.jsonl");
    h.agents.transcript = [];
    expect(await h.service.listing()).toMatchObject({ status: "idle", lastReply: { text: "Morning, Isaac." } });
  });
});

describe("assistant.agents list", () => {
  const frames = (broadcasts: ServerMessage[]) => broadcasts.filter((message) => message.t === "assistant.agents");

  function pair() {
    const a = harness({ agent: { ...ASTRA, scope: "eCard Systems work" } });
    const n = harness({ agent: { ...NOVA, scope: "Personal" }, beside: a });
    const broadcasts: ServerMessage[] = [];
    const threads = new AssistantThreads([a.service, n.service], { broadcast: (message) => broadcasts.push(message), clock: a.clock, log: () => undefined });
    return { a, n, threads, broadcasts };
  }

  it("lists every agent in registry order with scope, status and last reply", async () => {
    const { a, n, threads } = pair();
    a.register("working");
    n.register("waiting");
    a.agents.transcript = [{ id: "a1", role: "assistant", text: "Reviewing the PR.", at: 7 }];
    expect(await threads.agents()).toEqual([
      { id: "astra", title: "Astra", scope: "eCard Systems work", status: "working", lastReply: { text: "Reviewing the PR.", at: 7 } },
      { id: "nova", title: "Nova", scope: "Personal", status: "needs_you" },
    ]);
  });

  it("broadcasts one debounced fresh list when a reply settles or a status moves, and nothing for streaming text or unchanged lists", async () => {
    const { a, n, threads, broadcasts } = pair();
    a.register("idle");
    n.register("idle");
    // Streaming growth and other sessions' news do not touch the list.
    threads.observe({ kind: "message", sessionId: "eva-1", id: "a1", text: "On", streaming: true });
    threads.observe({ kind: "conversation", sessionId: "s1", appended: [{ id: "x", role: "assistant", text: "other", at: 1 }] });
    a.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(frames(broadcasts)).toEqual([]);

    a.agents.transcript = [{ id: "a1", role: "assistant", text: "On it.", at: 5 }];
    threads.observe({ kind: "message", sessionId: "eva-1", id: "a1", text: "On it.", streaming: false });
    threads.observe({ kind: "conversation", sessionId: "eva-1", appended: [{ id: "a1", role: "assistant", text: "On it.", at: 5 }] });
    a.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(frames(broadcasts)).toEqual([
      {
        t: "assistant.agents",
        agents: [
          { id: "astra", title: "Astra", scope: "eCard Systems work", status: "idle", lastReply: { text: "On it.", at: 5 } },
          { id: "nova", title: "Nova", scope: "Personal", status: "idle" },
        ],
      },
    ]);

    // A silent answer settles but leaves the list as it was: no second frame.
    a.agents.transcript = [...a.agents.transcript, { id: "a2", role: "assistant", text: "(nothing to report)", at: 6 }];
    threads.observe({ kind: "message", sessionId: "eva-1", id: "a2", text: "(nothing to report)", streaming: false });
    a.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(frames(broadcasts)).toHaveLength(1);

    // Nova starts working.
    n.agents.sessions = n.agents.sessions.map((session) => (session.id === "nova-1" ? nova("working") : session));
    threads.observe({ kind: "sessions" });
    a.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(frames(broadcasts)).toHaveLength(2);
    expect(frames(broadcasts)[1]).toMatchObject({ agents: [{ id: "astra" }, { id: "nova", status: "working" }] });
  });

  it("goes out again after a request even when the list came out the same, so no phone is left behind", async () => {
    const { a, threads, broadcasts } = pair();
    a.agents.sessions = [astra("idle")];
    threads.observe({ kind: "sessions" });
    a.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(frames(broadcasts)).toHaveLength(1);
    await threads.agents();
    threads.observe({ kind: "message", sessionId: "eva-1", id: "m", text: "hi", streaming: false });
    a.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(frames(broadcasts)).toHaveLength(2);
  });

  it("sends no frames without broadcast deps", async () => {
    const h = harness();
    const threads = new AssistantThreads([h.service]);
    h.register("idle");
    threads.observe({ kind: "message", sessionId: "eva-1", id: "m", text: "hi", streaming: false });
    h.clock.advance(SNAPSHOT_DEBOUNCE_MS);
    await flush();
    expect(await threads.agents()).toEqual([{ id: "astra", title: "Astra", status: "idle" }]);
  });
});
