import { describe, expect, it } from "vitest";
import type { AgentSession, ServerMessage } from "@relay/protocol";
import { VOICE_NOTE } from "../src/assistant/voice";
import { CLOSE_WAIT_MS, LiveCall, liveInput, TICK_MS, TRANSCRIPT_WAIT_MS, type LiveThread } from "../src/live/call";
import { openAiKey, sessionBody, type LiveApi, type LiveEvent, type LiveSessionConfig, type SidebandEvents } from "../src/live/openai";
import { LiveService } from "../src/live/service";
import type { FrameSink } from "../src/seams";
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

class FakeApi implements LiveApi {
  config: LiveSessionConfig | null = null;
  offer: string | null = null;
  events: SidebandEvents | null = null;
  readonly sent: Record<string, unknown>[] = [];
  sidebandClosed = false;
  failCreate: Error | null = null;
  create(config: LiveSessionConfig, offer: string): Promise<{ sessionId: string; answer: string }> {
    if (this.failCreate !== null) return Promise.reject(this.failCreate);
    this.config = config;
    this.offer = offer;
    return Promise.resolve({ sessionId: "live_1", answer: "v=0 answer" });
  }
  attach(_sessionId: string, events: SidebandEvents): Promise<{ send: (event: Record<string, unknown>) => void; close: () => void }> {
    this.events = events;
    return Promise.resolve({
      send: (event) => this.sent.push({ ...event }),
      close: () => {
        this.sidebandClosed = true;
      },
    });
  }
  emit(event: LiveEvent): void {
    this.events?.event(event);
  }
  commentary(): string[] {
    return this.sent.filter((event) => event["type"] === "session.commentary.append").map((event) => String(event["content"]));
  }
}

class FakeThread implements LiveThread {
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
    return Promise.resolve([
      { role: "user", text: "Remind me about the dentist" },
      { role: "status", text: "job line" },
      { role: "assistant", text: "Done, Thursday at 9." },
    ]);
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

async function started(): Promise<{ call: LiveCall; api: FakeApi; thread: FakeThread; clock: FakeClock; sent: ServerMessage[]; ended: () => boolean }> {
  const api = new FakeApi();
  const thread = new FakeThread();
  const clock = new FakeClock();
  const sent: ServerMessage[] = [];
  let ended = false;
  const call = new LiveCall({
    callId: "l1",
    thread,
    api,
    voice: "marin",
    send: (message) => sent.push(message),
    clock,
    log: () => undefined,
    onEnded: () => {
      ended = true;
    },
  });
  await call.start("v=0 offer");
  return { call, api, thread, clock, sent, ended: () => ended };
}

function heard(api: FakeApi, words: string[], fromMs = 0): void {
  words.forEach((delta, index) => {
    api.emit({ type: "session.input_transcript.delta", delta, start_ms: fromMs + index * 200, end_ms: fromMs + (index + 1) * 200 });
  });
}

describe("live call", () => {
  it("creates the session from the phone's offer, answers it, greets and listens", async () => {
    const h = await started();
    expect(h.api.offer).toBe("v=0 offer");
    expect(h.api.config?.voice).toBe("marin");
    expect(h.api.config?.instructions).toContain("voice of Nova");
    expect(h.sent).toEqual([
      { t: "live.state", callId: "l1", agent: "nova", state: "connecting" },
      { t: "live.answer", callId: "l1", agent: "nova", sessionId: "live_1", sdp: "v=0 answer" },
      { t: "live.state", callId: "l1", agent: "nova", state: "listening" },
    ]);
    expect(h.api.sent[0]).toMatchObject({ type: "session.commentary.append", delegation_id: null });
  });

  it("hands Isaac's words to the thread as a voice turn and the settled reply back as commentary", async () => {
    const h = await started();
    heard(h.api, [" What's", " on my", " calendar?"]);
    h.api.emit({ type: "session.delegation.created", offset_ms: 600, delegation: { id: "item_1", type: "delegation", target: "client" } });
    await settle();
    expect(h.thread.turns).toEqual([`${VOICE_NOTE}\nWhat's on my calendar?`]);
    expect(h.sent.at(-1)).toEqual({ t: "live.state", callId: "l1", agent: "nova", state: "thinking", text: "What's on my calendar?" });
    h.thread.status = "working";
    h.call.observe({ kind: "sessions" });
    h.call.observe({ kind: "message", sessionId: "s-1", id: "m1", text: "You have **two** things", streaming: true });
    expect(h.api.commentary()).toHaveLength(1);
    h.call.observe({ kind: "message", sessionId: "s-1", id: "m1", text: "You have **two** things: [dentist](https://x.y) at 9.\n[[details]]\n- 09:00 dentist", streaming: true });
    expect(h.api.commentary().at(-1)).toBe("You have two things: dentist at 9.");
    expect(h.api.sent.at(-1)).toMatchObject({ delegation_id: "item_1" });
    h.call.observe({ kind: "message", sessionId: "s-1", id: "m1", text: "You have two things: dentist at 9.\n[[details]]\n- 09:00 dentist", streaming: false });
    expect(h.api.commentary()).toHaveLength(2);
    h.thread.status = "idle";
    h.call.observe({ kind: "sessions" });
    expect(h.sent.at(-1)).toEqual({ t: "live.state", callId: "l1", agent: "nova", state: "listening" });
  });

  it("waits briefly for words that arrive after the delegation, and only sends what is new", async () => {
    const h = await started();
    heard(h.api, [" Hey", " Nova,"]);
    h.api.emit({ type: "session.delegation.created", offset_ms: 800, delegation: { id: "item_1", type: "delegation", target: "client" } });
    await settle();
    expect(h.thread.turns).toEqual([]);
    heard(h.api, [" what", " time"], 400);
    await settle();
    expect(h.thread.turns).toEqual([`${VOICE_NOTE}\nHey Nova, what time`]);
    heard(h.api, [" Thanks"], 2_000);
    h.api.emit({ type: "session.delegation.created", offset_ms: 9_000, delegation: { id: "item_2", type: "delegation", target: "client" } });
    h.clock.advance(TRANSCRIPT_WAIT_MS);
    await settle();
    expect(h.thread.turns.at(-1)).toBe(`${VOICE_NOTE}\nThanks`);
  });

  it("ignores rows that were in the thread before the call delegated", async () => {
    const h = await started();
    h.call.observe({ kind: "message", sessionId: "s-1", id: "old", text: "Earlier reply.", streaming: false });
    expect(h.api.commentary()).toHaveLength(1);
  });

  it("tells the voice when the thread cannot be reached", async () => {
    const h = await started();
    h.thread.failTurn = new Error("agent_launch_failed");
    heard(h.api, [" Hi"]);
    h.api.emit({ type: "session.delegation.created", offset_ms: 200, delegation: { id: "item_1", type: "delegation", target: "client" } });
    await settle();
    expect(h.api.commentary().at(-1)).toContain("could not be reached");
    expect(h.sent.at(-1)).toMatchObject({ state: "listening" });
  });

  it("closes the session on hang-up and drops the sideband after final usage or a timeout", async () => {
    const h = await started();
    h.call.end();
    expect(h.api.sent.at(-1)).toMatchObject({ type: "session.close" });
    expect(h.sent.at(-1)).toEqual({ t: "live.state", callId: "l1", agent: "nova", state: "ended" });
    expect(h.ended()).toBe(true);
    expect(h.api.sidebandClosed).toBe(false);
    h.clock.advance(CLOSE_WAIT_MS);
    expect(h.api.sidebandClosed).toBe(true);
  });

  it("ends when OpenAI closes the session", async () => {
    const h = await started();
    h.api.emit({ type: "session.closed", reason: "peer_disconnected", usage: { seconds: 42 } });
    expect(h.ended()).toBe(true);
    expect(h.api.sidebandClosed).toBe(true);
  });

  it("falls back to the local call when GPT-Live refuses the session", async () => {
    const api = new FakeApi();
    api.failCreate = new Error("GPT-Live 401: bad key");
    const sent: ServerMessage[] = [];
    const call = new LiveCall({ callId: "l1", thread: new FakeThread(), api, voice: "marin", send: (m) => sent.push(m), clock: new FakeClock(), log: () => undefined, onEnded: () => undefined });
    await call.start("v=0");
    expect(sent.at(-1)).toEqual({ t: "live.state", callId: "l1", agent: "nova", state: "ended", error: "GPT-Live unavailable: GPT-Live 401: bad key", fallback: true });
  });

  it("while the thread works, tells the voice how long it has been at it", async () => {
    const h = await started();
    heard(h.api, [" Plan", " my", " week"]);
    h.api.emit({ type: "session.delegation.created", offset_ms: 600, delegation: { id: "item_1", type: "delegation", target: "client" } });
    await settle();
    h.clock.advance(TICK_MS);
    const thinking = h.api.sent.filter((event) => event["type"] === "session.thinking.append");
    expect(thinking).toContainEqual(expect.objectContaining({ delegation_id: "item_1", content: "Nova is still working on it (20 s so far). Background note; only mention it if Isaac asks." }));
  });

  it("gives the voice the time when Isaac starts talking in a new minute, not while he is mid-sentence", async () => {
    const h = await started();
    const clockAppends = (): number => h.api.sent.filter((event) => event["type"] === "session.thinking.append" && event["delegation_id"] === null).length;
    heard(h.api, [" Hi"]);
    expect(clockAppends()).toBe(0);
    h.clock.advance(61_000);
    heard(h.api, [" what"]);
    expect(clockAppends()).toBe(1);
    h.clock.advance(500);
    heard(h.api, [" time"]);
    expect(clockAppends()).toBe(1);
  });

  it("hands over only the words the voice did not answer itself", async () => {
    const h = await started();
    heard(h.api, [" What", " time", " is", " it?"]);
    h.api.emit({ type: "session.output_transcript.delta", delta: " It's", start_ms: 1_000, end_ms: 1_200 });
    h.api.emit({ type: "session.output_transcript.delta", delta: " three twenty.", start_ms: 1_200, end_ms: 1_600 });
    heard(h.api, [" And", " my", " calendar?"], 3_000);
    h.api.emit({ type: "session.delegation.created", offset_ms: 3_600, delegation: { id: "item_1", type: "delegation", target: "client" } });
    // The acknowledgement starts before the transcript wait ends; it must not swallow the request.
    h.api.emit({ type: "session.output_transcript.delta", delta: " One sec, checking.", start_ms: 3_700, end_ms: 4_200 });
    await settle();
    expect(h.thread.turns).toEqual([`${VOICE_NOTE}\nAnd my calendar?`]);
  });
});

describe("live session setup", () => {
  it("seeds the voice with the end of the thread and a greeting", () => {
    const input = liveInput(
      "Nova",
      [
        { role: "user", text: "a" },
        { role: "card", text: "x" },
        { role: "assistant", text: "b" },
      ],
      Date.UTC(2026, 9, 28, 19, 7),
    );
    expect(input.map((message) => message.role)).toEqual(["user", "assistant", "developer", "developer"]);
    expect(input[2]?.text).toMatch(/^The time is now Wednesday, October 28, 2026 at \d{1,2}:07 [AP]M\.$/);
    expect(sessionBody({ instructions: "i", voice: "marin", input })["input"]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "b" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: input[2]?.text }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: input[3]?.text }] },
    ]);
  });

  it("reads the key from the environment, else the agent home's secrets file", () => {
    expect(openAiKey(null, { OPENAI_API_KEY: " sk-env " })).toBe("sk-env");
    expect(openAiKey(null, {})).toBeNull();
  });

  it("answers live.start with fallback when the host has no key", () => {
    const sent: ServerMessage[] = [];
    const sink: FrameSink = {
      send: (message) => {
        sent.push(message);
      },
      close: () => undefined,
    };
    const service = new LiveService({ thread: () => new FakeThread(), api: null, voice: () => "marin", clock: new FakeClock(), log: () => undefined });
    service.receive(sink, { t: "live.start", callId: "l1", agent: "nova", sdp: "v=0" });
    expect(sent).toEqual([{ t: "live.state", callId: "l1", agent: "nova", state: "ended", error: "No OpenAI key on this host", fallback: true }]);
  });
});
