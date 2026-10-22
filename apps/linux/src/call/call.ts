// One phone call with an assistant: the phone's microphone in, the agent's replies spoken back,
// over the socket that started it. The call never talks to omp directly. It hands each utterance
// the ears transcribe to the agent's thread as a voice turn (`voiceTurn`), exactly like a typed
// turn, then listens to that thread's session through the provider changes the host already gets
// and says each reply sentence as soon as it has finished streaming in. While the reply is slow it
// says a short filler; speech while it is talking (barge-in) stops the audio at once.
//
//   connecting -> listening <-> hearing -> thinking -> speaking -> listening ... -> ended
//
// Only replies to the call's own turns are spoken: messages that were already in the thread, or
// still streaming from before the first voice turn, are not. A barge-in drops the rest of every
// reply that was being said.

import { CALL_OUTPUT_RATE, type AgentSession, type CallState, type ServerMessage } from "@relay/protocol";
import type { AgentProviderChange } from "../seams";
import type { SessionClock } from "../session";
import { voiceTurn } from "../assistant/voice";
import { ReplySpeech } from "./speech";

/** A reply that has not started speaking this long after the turn went in gets a filler first. */
export const FILLER_AFTER_MS = 1_500;
/** A turn the agent never starts working on within this long stops holding the call in `thinking`. */
export const TURN_START_GRACE_MS = 20_000;

/** What the ears report for one call. */
export interface EarsEvents {
  /** Speech began (the barge-in cue). */
  speechStart(): void;
  /** One finished utterance, as text (may be empty when the ears heard only noise). */
  transcript(text: string): void;
  /** The ears died; the call cannot hear any more. */
  failed(reason: string): void;
}

/** One call's stream into the ears. */
export interface Ears {
  /** PCM16 LE mono at CALL_INPUT_RATE, base64. */
  audio(pcm: string): void;
  /** Drop any half-heard utterance. */
  reset(): void;
  close(): void;
}

/** The speech models a call runs on (eva-realtime's ears and brain, pocket-tts). */
export interface VoiceStack {
  /** Opens a stream into the ears; resolves once they are warm. Rejects when they cannot start. */
  ears(events: EarsEvents): Promise<Ears>;
  /** A short spoken acknowledgement of `heard` to say while the agent thinks. */
  filler(heard: string): Promise<string>;
  /** `text` said in `voice` (a pocket-tts voice; the default when absent) as PCM16 LE mono at CALL_OUTPUT_RATE, in pieces as it is made. Ends early when `signal` aborts. */
  speak(text: string, voice: string | undefined, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** The assistant thread a call talks to. */
export interface CallThread {
  readonly id: string;
  readonly title: string;
  /** The pocket-tts voice the agent speaks in; absent for the default. */
  readonly voice?: string;
  /** The agent's live omp session, when it runs. */
  session(): AgentSession | undefined;
  /** Delivers `text` as Isaac's next turn, starting the agent first if needed. */
  turn(text: string): Promise<void>;
}

export interface CallDeps {
  readonly callId: string;
  readonly thread: CallThread;
  readonly voice: VoiceStack;
  /** Sends a frame to the phone on the call. */
  readonly send: (message: ServerMessage) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** Called once, after the call has ended. */
  readonly onEnded: () => void;
}

/** Ears output that is no words: empty, punctuation, or a bracketed noise tag like `[BLANK_AUDIO]`. */
function isNoise(text: string): boolean {
  return !/[a-z0-9]/i.test(text) || /^[[(].*[\])]$/.test(text);
}

export class VoiceCall {
  readonly id: string;
  private state: CallState | null = null;
  private stateText: string | undefined;
  /** What the resting state shows: the words being answered while thinking, or why a turn failed. */
  private restText: string | undefined;
  private ears: Ears | null = null;
  private ended = false;
  private muted = false;
  /** Isaac is mid-utterance (speech started, no transcript yet). */
  private hearing = false;
  /** Audio generation; a barge-in moves to the next and the phone drops older audio. */
  private gen = 0;
  private readonly queue: string[] = [];
  private pumping = false;
  private abort: AbortController | null = null;
  /** When the phone will have played everything sent so far (clock ms). */
  private playEndsAt = 0;
  private cancelIdle: (() => void) | null = null;
  /** Replies being said, by message id; kept so a repeated final update says nothing twice. */
  private readonly replies = new Map<string, ReplySpeech>();
  /** Messages never to say: in the thread before the first voice turn, or cut off by a barge-in. */
  private readonly ignored = new Set<string>();
  /** Set by the first voice turn; replies only count from then on. */
  private talking = false;
  /** A voice turn went in and the agent has not finished it. */
  private awaiting = false;
  private sawWorking = false;
  /** Whether anything of the agent's (not the filler) was queued since the last voice turn. */
  private replied = false;
  private turnSeq = 0;
  private turnAt = 0;
  private firstAudioLogged = true;
  private cancelFiller: (() => void) | null = null;
  private cancelGrace: (() => void) | null = null;

  constructor(private readonly deps: CallDeps) {
    this.id = deps.callId;
  }

  get agent(): string {
    return this.deps.thread.id;
  }

  get current(): CallState | null {
    return this.state;
  }

  async start(): Promise<void> {
    this.setState("connecting");
    let ears: Ears;
    try {
      ears = await this.deps.voice.ears({
        speechStart: () => {
          this.speechStarted();
        },
        transcript: (text) => {
          this.heard(text);
        },
        failed: (reason) => {
          this.end(`speech recognition stopped: ${reason}`);
        },
      });
    } catch (error) {
      this.end(`speech models unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.ended) {
      ears.close();
      return;
    }
    this.ears = ears;
    this.deps.log(`call ${this.id}: ${this.deps.thread.title} is listening`);
    this.setState("listening");
  }

  /** Microphone audio from the phone. */
  audio(pcm: string): void {
    if (!this.ended && !this.muted) this.ears?.audio(pcm);
  }

  mute(muted: boolean): void {
    if (this.ended || muted === this.muted) return;
    this.muted = muted;
    if (!muted) return;
    this.ears?.reset();
    this.hearing = false;
    this.refresh();
  }

  /** Hangs up (the phone, the socket closing, or a failure with `error`). */
  end(error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.abort?.abort();
    this.cancelIdle?.();
    this.cancelFiller?.();
    this.cancelGrace?.();
    this.queue.length = 0;
    this.ears?.close();
    this.ears = null;
    this.deps.log(`call ${this.id}: ended${error === undefined ? "" : ` (${error})`}`);
    this.deps.send({ t: "call.state", callId: this.id, agent: this.agent, state: "ended", ...(error === undefined ? {} : { error }) });
    this.state = "ended";
    this.deps.onEnded();
  }

  /** Every provider change; the call picks out its agent's session. */
  observe(change: AgentProviderChange): void {
    if (this.ended) return;
    const session = this.deps.thread.session();
    if (session === undefined) return;
    if (change.kind === "sessions") {
      if (!this.awaiting) return;
      if (session.status === "working" || session.status === "needs_permission") {
        this.sawWorking = true;
        return;
      }
      if (this.sawWorking) this.turnDone();
      return;
    }
    if (change.kind === "message" && change.sessionId === session.id) {
      this.reply(change.id, change.text, !change.streaming);
      return;
    }
    if (change.kind === "conversation" && change.sessionId === session.id) {
      for (const message of change.appended) {
        if (message.role === "assistant") this.reply(message.id, message.text, message.streaming !== true);
      }
    }
  }

  private speechStarted(): void {
    if (this.ended || this.muted) return;
    this.hearing = true;
    if (this.pumping || this.queue.length > 0 || this.deps.clock.now() < this.playEndsAt) this.bargeIn();
    this.setState("hearing");
  }

  /** Isaac talked over the call: stop the audio and forget the rest of what was being said. */
  private bargeIn(): void {
    this.gen += 1;
    this.deps.send({ t: "call.flush", callId: this.id, gen: this.gen });
    this.abort?.abort();
    this.queue.length = 0;
    this.playEndsAt = this.deps.clock.now();
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.cancelFiller?.();
    this.cancelFiller = null;
    for (const id of this.replies.keys()) this.ignored.add(id);
    this.replies.clear();
    this.deps.log(`call ${this.id}: barge-in`);
  }

  private heard(raw: string): void {
    if (this.ended) return;
    this.hearing = false;
    const text = raw.trim();
    if (isNoise(text)) {
      this.refresh();
      return;
    }
    this.talking = true;
    this.awaiting = true;
    this.sawWorking = false;
    this.replied = false;
    this.firstAudioLogged = false;
    const turn = (this.turnSeq += 1);
    this.turnAt = this.deps.clock.now();
    this.deps.log(`call ${this.id}: heard "${text}"`);
    this.restText = text;
    this.setState("thinking", text);
    const filler = this.deps.voice.filler(text).catch((error: unknown) => {
      this.deps.log(`call ${this.id}: no filler: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    });
    this.cancelFiller?.();
    this.cancelFiller = this.deps.clock.after(FILLER_AFTER_MS, () => {
      this.cancelFiller = null;
      void filler.then((line) => {
        if (this.ended || turn !== this.turnSeq || this.replied || line.trim() === "") return;
        this.deps.log(`call ${this.id}: filler "${line}" at +${String(this.deps.clock.now() - this.turnAt)}ms`);
        this.enqueue(line);
      });
    });
    this.cancelGrace?.();
    this.cancelGrace = this.deps.clock.after(TURN_START_GRACE_MS, () => {
      this.cancelGrace = null;
      if (turn === this.turnSeq && this.awaiting && !this.sawWorking) this.turnDone();
    });
    this.deps.thread.turn(voiceTurn(text)).catch((error: unknown) => {
      if (this.ended || turn !== this.turnSeq) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`call ${this.id}: turn not delivered: ${message}`);
      this.turnDone(`Couldn't reach ${this.deps.thread.title}: ${message}`);
    });
  }

  /** The agent finished the turn (or never took it up, `note` says why): once the audio is out, the call listens again. */
  private turnDone(note?: string): void {
    this.awaiting = false;
    this.restText = note;
    this.cancelFiller?.();
    this.cancelFiller = null;
    this.cancelGrace?.();
    this.cancelGrace = null;
    if (!this.pumping && this.queue.length === 0) this.scheduleIdle();
  }

  private reply(id: string, text: string, settled: boolean): void {
    if (this.ignored.has(id)) return;
    let speech = this.replies.get(id);
    if (speech === undefined) {
      if (!this.talking) {
        this.ignored.add(id);
        return;
      }
      speech = new ReplySpeech();
      this.replies.set(id, speech);
    }
    const fresh = speech.next(text, settled);
    if (fresh.length === 0) return;
    if (!this.replied) {
      this.replied = true;
      this.cancelFiller?.();
      this.cancelFiller = null;
      this.deps.log(`call ${this.id}: first reply sentence at +${String(this.deps.clock.now() - this.turnAt)}ms`);
    }
    for (const sentence of fresh) this.enqueue(sentence);
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    if (!this.pumping) void this.pump();
  }

  /** Says the queued sentences in order, streaming each one's audio to the phone as it is made. */
  private async pump(): Promise<void> {
    this.pumping = true;
    this.cancelIdle?.();
    this.cancelIdle = null;
    while (!this.ended && this.queue.length > 0) {
      const text = this.queue.shift() ?? "";
      const gen = this.gen;
      const abort = new AbortController();
      this.abort = abort;
      this.setState("speaking", text);
      try {
        for await (const pcm of this.deps.voice.speak(text, this.deps.thread.voice, abort.signal)) {
          // `end()` and a barge-in abort; a barge-in also moves to the next generation.
          if (abort.signal.aborted || gen !== this.gen) break;
          if (!this.firstAudioLogged) {
            this.firstAudioLogged = true;
            this.deps.log(`call ${this.id}: first audio at +${String(this.deps.clock.now() - this.turnAt)}ms`);
          }
          this.deps.send({ t: "call.audio", callId: this.id, gen, pcm: Buffer.from(pcm).toString("base64") });
          const now = this.deps.clock.now();
          this.playEndsAt = Math.max(now, this.playEndsAt) + (pcm.byteLength / 2 / CALL_OUTPUT_RATE) * 1000;
        }
      } catch (error) {
        if (!abort.signal.aborted) this.deps.log(`call ${this.id}: speech failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.abort = null;
    this.pumping = false;
    if (!this.ended) this.scheduleIdle();
  }

  /** Once the phone has played what it was sent, the call goes back to hearing, thinking or listening. */
  private scheduleIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = this.deps.clock.after(Math.max(0, this.playEndsAt - this.deps.clock.now()), () => {
      this.cancelIdle = null;
      if (!this.pumping && this.queue.length === 0) this.refresh();
    });
  }

  /** The resting state when nothing is playing. */
  private refresh(): void {
    if (this.ended || this.pumping || this.queue.length > 0) return;
    this.setState(this.hearing ? "hearing" : this.awaiting ? "thinking" : "listening", this.hearing ? undefined : this.restText);
  }

  private setState(state: CallState, text?: string): void {
    if (this.ended || (state === this.state && text === this.stateText)) return;
    this.state = state;
    this.stateText = text;
    this.deps.send({ t: "call.state", callId: this.id, agent: this.agent, state, ...(text === undefined ? {} : { text }) });
  }
}
