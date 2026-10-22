import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSession, CallState, ServerMessage } from "@relay/protocol";
import { VOICE_NOTE, splitVoiceTurn, spokenPart, voiceTurn, withoutDetailsMarker } from "../src/assistant/voice";
import { FILLER_AFTER_MS, TURN_START_GRACE_MS, VoiceCall, type CallThread, type Ears, type EarsEvents, type VoiceStack } from "../src/call/call";
import { ReplySpeech, sentences, speakable } from "../src/call/speech";
import { wavDataStart } from "../src/call/voice";
import type { AgentProviderChange } from "../src/seams";
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

/** 100 ms of silence at 24 kHz, the piece the fake mouth says per sentence. */
const PIECE = new Uint8Array(4_800);

class FakeVoice implements VoiceStack {
  events: EarsEvents | null = null;
  readonly heard: string[] = [];
  readonly said: string[] = [];
  resets = 0;
  closed = false;
  fail: Error | null = null;
  fillerLine = "One sec.";
  readonly fillersAsked: string[] = [];
  ears(events: EarsEvents): Promise<Ears> {
    if (this.fail !== null) return Promise.reject(this.fail);
    this.events = events;
    return Promise.resolve({
      audio: (pcm) => this.heard.push(pcm),
      reset: () => {
        this.resets += 1;
      },
      close: () => {
        this.closed = true;
      },
    });
  }
  filler(heard: string): Promise<string> {
    this.fillersAsked.push(heard);
    return Promise.resolve(this.fillerLine);
  }
  async *speak(text: string, _voice: string | undefined, signal: AbortSignal): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    if (signal.aborted) return;
    this.said.push(text);
    yield PIECE;
  }
}

class FakeThread implements CallThread {
  readonly id = "astra";
  readonly title = "Astra";
  readonly turns: string[] = [];
  status: AgentSession["status"] = "idle";
  failTurn: Error | null = null;
  session(): AgentSession {
    return { id: "s-1", provider: "omp", title: "Astra", projectPath: "/Users/ike/Eva", status: this.status, lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant", assistant: "astra" };
  }
  turn(text: string): Promise<void> {
    if (this.failTurn !== null) return Promise.reject(this.failTurn);
    this.turns.push(text);
    return Promise.resolve();
  }
}

/** Lets the call's promise chains (ears, turn, filler, the speaking loop) run; microtasks only, no wall clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

interface Harness {
  readonly call: VoiceCall;
  readonly voice: FakeVoice;
  readonly thread: FakeThread;
  readonly clock: FakeClock;
  readonly sent: ServerMessage[];
  ended(): boolean;
  states(): CallState[];
}

async function harness(): Promise<Harness> {
  const voice = new FakeVoice();
  const thread = new FakeThread();
  const clock = new FakeClock();
  const sent: ServerMessage[] = [];
  let ended = false;
  const call = new VoiceCall({
    callId: "c1",
    thread,
    voice,
    send: (message) => sent.push(message),
    clock,
    log: () => undefined,
    onEnded: () => {
      ended = true;
    },
  });
  await call.start();
  return {
    call,
    voice,
    thread,
    clock,
    sent,
    ended: () => ended,
    states: () => sent.flatMap((message) => (message.t === "call.state" ? [message.state] : [])),
  };
}

const update = (id: string, text: string, streaming: boolean): AgentProviderChange => ({ kind: "message", sessionId: "s-1", id, text, streaming });
const appended = (message: AgentMessage): AgentProviderChange => ({ kind: "conversation", sessionId: "s-1", appended: [message] });

/** Isaac says `text`: speech starts, the ears hand back the transcript. */
async function say(h: Harness, text: string): Promise<void> {
  h.voice.events?.speechStart();
  h.voice.events?.transcript(text);
  await settle();
}

/** The agent takes the turn and starts working. */
function working(h: Harness): void {
  h.thread.status = "working";
  h.call.observe({ kind: "sessions" });
}

function idle(h: Harness): void {
  h.thread.status = "idle";
  h.call.observe({ kind: "sessions" });
}

describe("voice turns in the thread", () => {
  it("a voice turn carries the note on its own first line; the phone's view gets the words back, marked voice", () => {
    const turn = voiceTurn("what time is it");
    expect(turn.split("\n")[0]).toBe(VOICE_NOTE);
    expect(splitVoiceTurn(turn)).toEqual({ text: "what time is it", voice: true });
    expect(splitVoiceTurn("[Voice call: an older wording]\nhello")).toEqual({ text: "hello", voice: true });
    expect(splitVoiceTurn("typed")).toEqual({ text: "typed", voice: false });
  });

  it("the spoken part ends at the details marker, which the chat shows as a paragraph break", () => {
    const reply = "It's 4:30.\n[[details]]\nYour next meeting is at 5.";
    expect(spokenPart(reply)).toBe("It's 4:30.\n");
    expect(withoutDetailsMarker(reply)).toBe("It's 4:30.\n\nYour next meeting is at 5.");
    expect(withoutDetailsMarker("No marker here.  ")).toBe("No marker here.  ");
  });
});

describe("speech from replies", () => {
  it("speaks plain words: drops code, images, tables and markup, keeps link text, says bare links as 'a link'", () => {
    const markdown = [
      "## Done",
      "I **fixed** the `build` — see [the PR](https://github.com/x/y/pull/1).",
      "- first item",
      "- second item",
      "```ts",
      "const x = 1;",
      "```",
      "| a | b |",
      "![shot](/drops/1/t)",
      "Logs at https://example.com/logs",
    ].join("\n");
    expect(speakable(markdown, false)).toBe("Done. I fixed the build, see the PR. first item. second item. Logs at a link");
  });

  it("while streaming, an unclosed fence hides the rest and a half-written sign-in token is held back", () => {
    expect(speakable("Here it is.\n```ts\nconst", true)).toBe("Here it is.");
    expect(speakable("Sign in please [[sign", true)).toBe("Sign in please");
  });

  it("spells clock times the way the voice says them right", () => {
    expect(speakable("It's 2:12 PM. Standup at 9:05, lunch at 12:00 and the call at 3:00 pm.", false)).toBe(
      "It's 2 12 PM. Standup at 9 oh 5, lunch at 12 o'clock and the call at 3 pm.",
    );
  });

  it("cuts sentences at end punctuation", () => {
    expect(sentences("It's 4:30. Anything else? Sure!")).toEqual(["It's 4:30.", "Anything else?", "Sure!"]);
  });

  it("says each sentence once it is certainly finished, all of the rest when settled, nothing twice", () => {
    const speech = new ReplySpeech();
    expect(speech.next("It's four", false)).toEqual([]);
    expect(speech.next("It's four thirty. Anything", false)).toEqual(["It's four thirty."]);
    expect(speech.next("It's four thirty. Anything else? Bye", false)).toEqual(["Anything else?"]);
    expect(speech.next("It's four thirty. Anything else? Bye.", true)).toEqual(["Bye."]);
    expect(speech.next("It's four thirty. Anything else? Bye.", true)).toEqual([]);
  });

  it("never says the silence marker, whole or on its way in", () => {
    const speech = new ReplySpeech();
    expect(speech.next("(nothing to", false)).toEqual([]);
    expect(speech.next("(nothing to report)", true)).toEqual([]);
  });
});

describe("pocket-tts stream", () => {
  const header = (rate: number, channels: number): Uint8Array => {
    const bytes = new Uint8Array(44);
    const view = new DataView(bytes.buffer);
    const ascii = new TextEncoder();
    bytes.set(ascii.encode("RIFF"), 0);
    bytes.set(ascii.encode("WAVE"), 8);
    bytes.set(ascii.encode("fmt "), 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, rate, true);
    view.setUint16(34, 16, true);
    bytes.set(ascii.encode("data"), 36);
    view.setUint32(40, 0x7fffffff, true);
    return bytes;
  };

  it("finds the samples after a streamed header, waits for a partial one, and refuses a format calls cannot play", () => {
    expect(wavDataStart(header(24_000, 1))).toBe(44);
    expect(wavDataStart(header(24_000, 1).subarray(0, 30))).toBeNull();
    expect(() => wavDataStart(header(44_100, 1))).toThrow(/mono 24000 Hz/);
    expect(() => wavDataStart(new TextEncoder().encode("<html>nope</html>"))).toThrow(/WAV/);
  });
});

describe("a call", () => {
  it("connects, then listens; failing ears end it with the reason", async () => {
    const h = await harness();
    expect(h.states()).toEqual(["connecting", "listening"]);
    const voice = new FakeVoice();
    voice.fail = new Error("no venv");
    const sent: ServerMessage[] = [];
    let ended = false;
    const call = new VoiceCall({ callId: "c2", thread: new FakeThread(), voice, send: (message) => sent.push(message), clock: new FakeClock(), log: () => undefined, onEnded: () => { ended = true; } });
    await call.start();
    expect(sent.at(-1)).toEqual({ t: "call.state", callId: "c2", agent: "astra", state: "ended", error: "speech models unavailable: no venv" });
    expect(ended).toBe(true);
  });

  it("passes the microphone to the ears unless muted; muting drops a half-heard utterance", async () => {
    const h = await harness();
    h.call.audio("AAAA");
    h.call.mute(true);
    h.call.audio("BBBB");
    h.call.mute(false);
    h.call.audio("CCCC");
    expect(h.voice.heard).toEqual(["AAAA", "CCCC"]);
    expect(h.voice.resets).toBe(1);
  });

  it("hands what it heard to the thread as a voice turn, then speaks the reply sentence by sentence and listens again once played", async () => {
    const h = await harness();
    await say(h, "what time is it");
    expect(h.thread.turns).toEqual([voiceTurn("what time is it")]);
    expect(h.sent.at(-1)).toEqual({ t: "call.state", callId: "c1", agent: "astra", state: "thinking", text: "what time is it" });
    working(h);
    h.call.observe(appended({ id: "r1", role: "assistant", text: "", at: 2, streaming: true }));
    h.call.observe(update("r1", "It's four", true));
    await settle();
    expect(h.voice.said).toEqual([]);
    h.call.observe(update("r1", "It's four thirty. Anything", true));
    await settle();
    expect(h.voice.said).toEqual(["It's four thirty."]);
    expect(h.sent).toContainEqual({ t: "call.audio", callId: "c1", gen: 0, pcm: Buffer.from(PIECE).toString("base64") });
    h.call.observe(update("r1", "It's four thirty. Anything else?", false));
    h.call.observe(appended({ id: "r1", role: "assistant", text: "It's four thirty. Anything else?", at: 2 }));
    idle(h);
    await settle();
    expect(h.voice.said).toEqual(["It's four thirty.", "Anything else?"]);
    expect(h.call.current).toBe("speaking");
    h.clock.advance(250);
    expect(h.call.current).toBe("listening");
    expect(h.states()).toEqual(["connecting", "listening", "hearing", "thinking", "speaking", "speaking", "listening"]);
  });

  it("says the Qwen filler when the reply is slower than FILLER_AFTER_MS, and none when the reply is quicker", async () => {
    const slow = await harness();
    await say(slow, "check my PRs");
    working(slow);
    slow.clock.advance(FILLER_AFTER_MS);
    await settle();
    expect(slow.voice.fillersAsked).toEqual(["check my PRs"]);
    expect(slow.voice.said).toEqual(["One sec."]);
    slow.call.observe(update("r1", "Two are waiting.", false));
    await settle();
    expect(slow.voice.said).toEqual(["One sec.", "Two are waiting."]);

    const quick = await harness();
    await say(quick, "what time is it");
    working(quick);
    quick.call.observe(update("r1", "It's four thirty.", false));
    quick.clock.advance(FILLER_AFTER_MS);
    await settle();
    expect(quick.voice.said).toEqual(["It's four thirty."]);
  });

  it("barge-in: speech while it talks flushes the phone's audio and drops the rest of that reply", async () => {
    const h = await harness();
    await say(h, "tell me about my day");
    working(h);
    h.call.observe(update("r1", "You have three meetings. The first", true));
    await settle();
    expect(h.voice.said).toEqual(["You have three meetings."]);
    h.voice.events?.speechStart();
    expect(h.sent).toContainEqual({ t: "call.flush", callId: "c1", gen: 1 });
    expect(h.call.current).toBe("hearing");
    h.call.observe(update("r1", "You have three meetings. The first is at nine. The second", false));
    await settle();
    expect(h.voice.said).toEqual(["You have three meetings."]);
    h.voice.events?.transcript("just the first one");
    await settle();
    h.call.observe(update("r2", "Standup at nine.", false));
    await settle();
    expect(h.voice.said).toEqual(["You have three meetings.", "Standup at nine."]);
    expect(h.sent.filter((message) => message.t === "call.audio").at(-1)).toMatchObject({ gen: 1 });
  });

  it("says nothing of the thread from before its first voice turn, and nothing after the details marker", async () => {
    const h = await harness();
    h.call.observe(update("old", "An earlier reply. Still streaming", true));
    h.call.observe(update("old", "An earlier reply. Still streaming.", false));
    await settle();
    expect(h.voice.said).toEqual([]);
    await say(h, "summary please");
    working(h);
    h.call.observe(update("r1", "Two things need you.\n[[details]]\n- PR 12\n- ENG-6409", false));
    await settle();
    expect(h.voice.said).toEqual(["Two things need you."]);
  });

  it("ignores noise from the ears and goes back to listening", async () => {
    const h = await harness();
    await say(h, "[BLANK_AUDIO]");
    expect(h.thread.turns).toEqual([]);
    expect(h.call.current).toBe("listening");
  });

  it("a turn the thread cannot take, or never starts on, puts the call back to listening", async () => {
    const h = await harness();
    h.thread.failTurn = new Error("Astra did not come up within 30 s");
    await say(h, "hello");
    h.clock.advance(0);
    expect(h.sent.at(-1)).toEqual({ t: "call.state", callId: "c1", agent: "astra", state: "listening", text: "Couldn't reach Astra: Astra did not come up within 30 s" });
    expect(h.voice.said).toEqual([]);

    const stuck = await harness();
    await say(stuck, "hello");
    stuck.clock.advance(TURN_START_GRACE_MS);
    await settle();
    expect(stuck.call.current).not.toBe("thinking");
  });

  it("hanging up closes the ears, reports ended once, and takes no more audio", async () => {
    const h = await harness();
    h.call.end();
    h.call.end();
    h.call.audio("AAAA");
    expect(h.voice.closed).toBe(true);
    expect(h.voice.heard).toEqual([]);
    expect(h.ended()).toBe(true);
    expect(h.sent.filter((message) => message.t === "call.state" && message.state === "ended")).toHaveLength(1);
  });
});
