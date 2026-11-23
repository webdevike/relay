import { describe, expect, it } from "vitest";
import { MAX_LIVE_CALL_MS, type AgentSession, type ServerMessage } from "@relay/protocol";
import { SILENCE_MARKER } from "../src/assistant/service";
import { voiceTurn } from "../src/assistant/voice";
import type { CallThread } from "../src/call/call";
import { deepgramAgentLayer } from "../src/call/deepgram";
import { ASK_ASSISTANT, DeepgramCall, deepgramLayer } from "../src/call/deepgramCall";
import type { AgentProviderChange } from "../src/seams";
import type { SessionClock } from "../src/session";
import { type EngineEnv, resolveVoiceEngines, type PcmCallDeps } from "../src/voice/engines";
import { FakeSocket, type Server } from "./deepgram-fake";

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
  pending(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

class FakeThread implements CallThread {
  readonly id = "nova";
  readonly title = "Nova";
  readonly turns: string[] = [];
  status: AgentSession["status"] = "idle";
  failTurn: Error | null = null;
  session(): AgentSession {
    return { id: "s-1", provider: "omp", title: "Nova", projectPath: "/Users/ike/Eva", status: this.status, lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant", assistant: "nova" };
  }
  turn(text: string): Promise<void> {
    if (this.failTurn !== null) return Promise.reject(this.failTurn);
    this.turns.push(text);
    return Promise.resolve();
  }
  rows(): Promise<{ role: string; text: string }[]> {
    return Promise.resolve([{ role: "assistant", text: "Dentist is Thursday." }]);
  }
  memory(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/** Lets promise chains and the fake socket's 0 ms timers run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
}

interface Harness {
  readonly call: DeepgramCall;
  readonly socket: FakeSocket;
  readonly thread: FakeThread;
  readonly clock: FakeClock;
  readonly sent: ServerMessage[];
  readonly ended: () => number;
  readonly started: boolean;
}

async function open(server: Server = "applies"): Promise<Harness> {
  const socket = new FakeSocket(server);
  const thread = new FakeThread();
  const clock = new FakeClock();
  const sent: ServerMessage[] = [];
  let endedCount = 0;
  const deps: PcmCallDeps = {
    callId: "c1",
    thread,
    send: (frame) => sent.push(frame),
    clock,
    log: () => undefined,
    onEnded: () => {
      endedCount += 1;
    },
  };
  const call = new DeepgramCall(deps, deepgramAgentLayer("dg-synthetic-key", () => socket));
  const started = await call.start();
  return { call, socket, thread, clock, sent, ended: () => endedCount, started };
}

const states = (h: Harness): string[] => h.sent.flatMap((m) => (m.t === "call.state" ? [m.state] : []));
const injected = (h: Harness): string[] => h.socket.json().flatMap((m) => (m.type === "InjectAgentMessage" ? [(m as unknown as { message: string }).message] : []));

function replyChange(id: string, text: string, streaming = false): AgentProviderChange {
  return { kind: "message", sessionId: "s-1", id, text, streaming };
}

/** Isaac says `words` and the voice hands them over. */
async function ask(h: Harness, words: string, functionId = "f1"): Promise<void> {
  h.socket.emit({ type: "UserStartedSpeaking" });
  h.socket.emit({ type: "ConversationText", role: "user", content: words });
  h.socket.emit({ type: "FunctionCallRequest", functions: [{ id: functionId, name: ASK_ASSISTANT, arguments: JSON.stringify({ question: "paraphrase" }), client_side: true }] });
  await settle();
}

describe("Deepgram call", () => {
  it("opens with the assistant's brief, reports listening, and passes the microphone through unless muted", async () => {
    const h = await open();
    expect(h.started).toBe(true);
    expect(states(h)).toEqual(["listening"]);
    const settings = JSON.parse(h.socket.sent[0] as string) as { agent: { think: { prompt: string; functions: { name: string; defer_until_eot: boolean }[] }; context: { messages: unknown[] } } };
    expect(settings.agent.think.prompt).toContain("You are Nova");
    expect(settings.agent.think.functions).toMatchObject([{ name: ASK_ASSISTANT, defer_until_eot: true }]);
    expect(settings.agent.context.messages).toEqual([{ type: "History", role: "assistant", content: "Dentist is Thursday." }]);
    h.call.audio(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(Array.from(h.socket.sent.at(-1) as Uint8Array)).toEqual([1, 2, 3, 4]);
    h.call.mute(true);
    h.call.audio(Buffer.from([5, 6]).toString("base64"));
    expect(Array.from(h.socket.sent.at(-1) as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it("shows speaking from the greeting's first audio and listening again when it is done", async () => {
    const h = await open();
    h.socket.onmessage?.({ data: new Uint8Array([1, 1]).buffer });
    await settle();
    expect(states(h)).toEqual(["listening", "speaking"]);
    h.socket.emit({ type: "AgentAudioDone" });
    await settle();
    expect(states(h)).toEqual(["listening", "speaking", "listening"]);
  });

  it("hands Isaac's exact words to the thread once as a voice turn, answers the function at once, and speaks the reply's spoken part", async () => {
    const h = await open();
    h.call.observe(replyChange("old", "Said before the call talked."));
    await ask(h, "what's on my calendar tomorrow");
    expect(h.thread.turns).toEqual([voiceTurn("what's on my calendar tomorrow")]);
    expect(h.socket.json().find((m) => m.type === "FunctionCallResponse")).toMatchObject({ id: "f1", name: ASK_ASSISTANT });
    expect(states(h)).toEqual(["listening", "hearing", "thinking"]);
    expect(h.sent.at(-1)).toMatchObject({ t: "call.state", state: "thinking", text: "what's on my calendar tomorrow" });

    h.call.observe(replyChange("r1", "You have a dentist visit at nine."));
    h.call.observe(replyChange("r1", "You have a dentist visit at nine.\n[[details]]\nAddress: 12 Main St."));
    h.call.observe(replyChange("r1", "You have a dentist visit at nine.\n[[details]]\nAddress: 12 Main St.\nBring forms."));
    expect(injected(h)).toEqual(["You have a dentist visit at nine."]);
    expect(injected(h).join(" ")).not.toContain("Main St");
    expect(injected(h).join(" ")).not.toContain("Said before");
    expect(h.thread.turns).toHaveLength(1);
  });

  it("says nothing for a silent reply and returns to listening when the assistant settles", async () => {
    const h = await open();
    await ask(h, "never mind");
    h.thread.status = "working";
    h.call.observe({ kind: "sessions" });
    h.call.observe(replyChange("r1", SILENCE_MARKER));
    h.thread.status = "idle";
    h.call.observe({ kind: "sessions" });
    expect(injected(h)).toEqual([]);
    expect(states(h).at(-1)).toBe("listening");
  });

  it("stops playback on a barge-in and drops the reply that was being said", async () => {
    const h = await open();
    await ask(h, "tell me a story");
    h.socket.onmessage?.({ data: new Uint8Array([7, 7]).buffer });
    h.socket.emit({ type: "AgentStartedSpeaking" });
    await settle();
    h.call.observe(replyChange("r1", "Once upon a time. There was a call."));
    expect(injected(h)).toEqual(["Once upon a time. There was a call."]);
    expect(h.sent.find((m) => m.t === "call.audio")).toMatchObject({ gen: 0, pcm: Buffer.from([7, 7]).toString("base64") });
    h.socket.emit({ type: "UserStartedSpeaking" });
    await settle();
    expect(h.sent.at(-2)).toMatchObject({ t: "call.flush", gen: 1 });
    h.call.observe(replyChange("r1", "Once upon a time. There was a call. And more."));
    expect(injected(h)).toHaveLength(1);
    h.socket.onmessage?.({ data: new Uint8Array([8, 8]).buffer });
    await settle();
    expect(h.sent.at(-1)).toMatchObject({ t: "call.audio", gen: 1 });
  });

  it("retries a line Deepgram refused once the agent is idle", async () => {
    const h = await open();
    await ask(h, "hello again");
    h.call.observe(replyChange("r1", "Hi there."));
    h.socket.emit({ type: "InjectionRefused" });
    await settle();
    expect(injected(h)).toEqual(["Hi there."]);
    h.socket.emit({ type: "AgentAudioDone" });
    await settle();
    expect(injected(h)).toEqual(["Hi there.", "Hi there."]);
  });

  it("tells the voice when the assistant cannot be reached", async () => {
    const h = await open();
    h.thread.failTurn = new Error("agent down");
    await ask(h, "are you there");
    expect(injected(h)).toEqual(["Sorry, I couldn't get to that just now."]);
  });

  it("falls back, silently, when the session never opens: nothing sent, not ended, socket closed", async () => {
    const h = await open("errors");
    expect(h.started).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.ended()).toBe(0);
    await settle();
    expect(h.socket.closed).toBe(1);
    expect(h.clock.pending()).toBe(0);
  });

  it.each<[string, (h: Harness) => void, string | undefined]>([
    ["the phone hangs up", (h) => { h.call.end("phone: done"); }, "phone: done"],
    ["the socket closes", (h) => { h.call.end(); }, undefined],
    ["Deepgram drops the connection", (h) => { h.socket.onclose?.({ reason: "bye" }); }, "The voice service dropped the call"],
    ["Deepgram reports an error", (h) => { h.socket.emit({ type: "Error", code: "FAILED_TO_THINK", description: "x" }); }, "Deepgram error FAILED_TO_THINK: x"],
    ["the call reaches its cap", (h) => { h.clock.advance(MAX_LIVE_CALL_MS); }, "The call reached its time limit"],
  ])("ends once, closing the session and every timer, when %s", async (_name, stop, error) => {
    const h = await open();
    await ask(h, "hold on");
    stop(h);
    await settle();
    h.call.end("again");
    h.call.audio("AAAA");
    h.socket.emit({ type: "ConversationText", role: "user", content: "late" });
    await settle();
    const ended = h.sent.filter((m) => m.t === "call.state" && m.state === "ended");
    expect(ended).toEqual([{ t: "call.state", callId: "c1", agent: "nova", state: "ended", ...(error === undefined ? {} : { error }) }]);
    expect(h.ended()).toBe(1);
    expect(h.socket.closed).toBe(1);
    expect(h.clock.pending()).toBe(0);
  });
});

describe("deepgramLayer", () => {
  it("is a PCM engine that opens only with a key", () => {
    // Synthetic env only; the host's own key file is not read (agentHome null).
    const without = engineOf({ agentHome: null, env: {} });
    expect(without).toMatchObject({ id: "deepgram", transport: "pcm-websocket", open: null });
    const withKey = engineOf({ agentHome: null, env: { DEEPGRAM_API_KEY: "dg-synthetic" } });
    expect(withKey.transport === "pcm-websocket" && withKey.open !== null).toBe(true);
  });
});

function engineOf(env: EngineEnv) {
  return resolveVoiceEngines(deepgramLayer(env)).select("nova");
}
