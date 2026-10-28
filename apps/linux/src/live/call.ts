// One GPT-Live call with an assistant. The phone's audio goes straight to OpenAI over WebRTC; the
// host only creates the session (its key never leaves the Mini) and is the brain behind it. It
// attaches to the session's sideband and, whenever the voice delegates, hands Isaac's words since
// the last delegation to the assistant's normal thread as a voice turn (`voiceTurn`, exactly like
// a turn on the local call), so they land in the chat and in the one memory thread. Each reply the
// assistant settles goes back as commentary for the voice to say in its own words.
//
//   connecting -> listening <-> thinking -> ... -> ended
//
// The voice handles small talk and acknowledgements itself; anything that needs facts, memory,
// the time, Isaac's things or an action is delegated (see `liveInstructions`): GPT-Live knows
// none of it, so answering by itself would mean guessing.

import { MAX_LIVE_CALL_MS, type AgentSession, type LiveState, type ServerMessage } from "@relay/protocol";
import { SILENCE_MARKER } from "../assistant/service";
import { spokenPartComplete, voiceTurn } from "../assistant/voice";
import { plainSpeech } from "../call/speech";
import type { AgentProviderChange } from "../seams";
import type { SessionClock } from "../session";
import type { LiveApi, LiveEvent, LiveInputMessage, Sideband } from "./openai";

/** A delegation waits at most this long for the transcript to reach the moment it was made. */
export const TRANSCRIPT_WAIT_MS = 700;
/** A turn the agent never starts working on within this long stops holding the call in `thinking`. */
export const TURN_START_GRACE_MS = 20_000;
/** After `session.close`, how long to wait for `session.closed` (final usage) before dropping the sideband. */
export const CLOSE_WAIT_MS = 3_000;
/** One append carries at most 500 tokens; replies are cut to this many characters. */
export const MAX_COMMENTARY_CHARS = 1_600;
/** Thread rows seeding the voice's context, newest last, and their combined size. */
export const HISTORY_ROWS = 12;
export const HISTORY_CHARS = 6_000;
const HISTORY_ROW_CHARS = 600;
/** While the assistant works, how often the voice is told how long it has been at it. */
export const TICK_MS = 20_000;
/** Isaac's transcript pausing this long (clock ms) starts a new utterance; the voice gets the time then. */
export const UTTERANCE_GAP_MS = 1_500;
/** The voice's transcript pausing this long (session ms) ends a stretch of its speech. */
export const VOICE_RUN_GAP_MS = 800;
/** A stretch of the voice's speech this long answered Isaac (shorter is a backchannel like "mm-hm"). */
export const VOICE_ANSWER_WORDS = 3;

/** The assistant thread a live call talks to. */
export interface LiveThread {
  readonly id: string;
  readonly title: string;
  /** The agent's live omp session, when it runs. */
  session(): AgentSession | undefined;
  /** Delivers `text` as Isaac's next turn, starting the agent first if needed. */
  turn(text: string): Promise<void>;
  /** The thread's rows as the chat shows them, oldest first. */
  rows(): Promise<readonly { readonly role: string; readonly text: string }[]>;
}

export interface LiveCallDeps {
  readonly callId: string;
  readonly thread: LiveThread;
  readonly api: LiveApi;
  /** GPT-Live voice name, e.g. "marin". */
  readonly voice: string;
  /** Sends a frame to the phone that started the call (dropped once its socket is gone). */
  readonly send: (message: ServerMessage) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** Called once, after the call has ended. */
  readonly onEnded: () => void;
}

/** The current time as the voice is told it, in the host's time zone (Isaac's). */
export function clockLine(at: number): string {
  const when = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
  return `The time is now ${when}.`;
}

/** The voice's prompt: who it speaks for, and that the assistant behind it does the thinking. */
export function liveInstructions(title: string): string {
  return [
    `You are the voice of ${title}, Isaac's personal assistant, on a live call he started from his iPhone. You speak for ${title}; never call yourself a voice model or mention a backend.`,
    `${title} herself works behind you: she knows Isaac, his projects, his notes and memory, his calendar, email and files, and can look things up and take actions. You know none of that and cannot see or do anything. You are told the current time as the call goes on: answer what time, day or date it is yourself from the latest time you were told.`,
    "Delegate every other request that needs facts, memory, Isaac's information, the web, or any action. The earlier messages you were given are only there so you know what he means; never answer from them, delegate so the answer is current. While it runs, at most a very short acknowledgement, then wait quietly; if Isaac asks, say it is still being worked on. Never guess or make up an answer. When the result arrives, say it naturally and briefly in your own words; keep names and numbers exact.",
    "Handle greetings, small talk, 'hold on', and questions about what he meant yourself. Be warm, relaxed and brief: one or two short sentences a turn. If Isaac talks over you, stop and listen.",
  ].join("\n\n");
}

/** Startup context: the end of the thread, so "that" and "it" make sense, the time, and a short hello. */
export function liveInput(title: string, rows: readonly { readonly role: string; readonly text: string }[], now: number): LiveInputMessage[] {
  const recent: LiveInputMessage[] = [];
  let budget = HISTORY_CHARS;
  for (const row of [...rows].reverse()) {
    if (recent.length === HISTORY_ROWS || budget <= 0) break;
    if (row.role !== "user" && row.role !== "assistant") continue;
    const text = row.text.trim().slice(0, Math.min(HISTORY_ROW_CHARS, budget));
    if (text === "") continue;
    budget -= text.length;
    recent.unshift({ role: row.role, text });
  }
  return [
    ...recent,
    { role: "developer", text: clockLine(now) },
    { role: "developer", text: `Isaac just started a call with ${title}. Greet him now in at most four words, like "Hey, what's up?", then pause and listen.` },
  ];
}

interface Heard {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export class LiveCall {
  readonly id: string;
  private state: LiveState | null = null;
  private stateText: string | undefined;
  private ended = false;
  private sideband: Sideband | null = null;
  private startedAt = 0;
  /**
   * Isaac's transcript so far, and how much of it is dealt with: handed to the assistant, or
   * answered by the voice itself (anything it said of VOICE_ANSWER_WORDS or more words).
   */
  private readonly heard: Heard[] = [];
  private handedOver = 0;
  /** The voice's current stretch of speech on the session timeline, and its words so far. */
  private voiceRun = { startMs: 0, endMs: -Infinity, words: 0 };
  /** When Isaac's transcript last grew (clock ms); a longer gap starts a new utterance. */
  private lastHeardAt = -Infinity;
  private transcriptWaiters: (() => void)[] = [];
  /** The delegation replies answer: the newest one. */
  private delegation: string | null = null;
  /** Set by the first delegation; replies only count from then on. */
  private talking = false;
  private awaiting = false;
  private sawWorking = false;
  private turnAt = 0;
  private turnSeq = 0;
  private replied = false;
  /** Replies already handed to the voice, and rows that were in the thread before the call talked. */
  private readonly said = new Set<string>();
  private readonly ignored = new Set<string>();
  private cancelGrace: (() => void) | null = null;
  private cancelCap: (() => void) | null = null;
  private closing: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;
  private lastClock = "";

  constructor(private readonly deps: LiveCallDeps) {
    this.id = deps.callId;
  }

  get agent(): string {
    return this.deps.thread.id;
  }

  /** Creates the session from the phone's `offer`, answers it, and attaches to the sideband. */
  async start(offer: string): Promise<void> {
    this.startedAt = this.deps.clock.now();
    this.setState("connecting");
    const rows = await this.deps.thread.rows().catch(() => []);
    let created: { sessionId: string; answer: string };
    try {
      created = await this.deps.api.create({ instructions: liveInstructions(this.deps.thread.title), voice: this.deps.voice, input: liveInput(this.deps.thread.title, rows, this.deps.clock.now()) }, offer);
    } catch (error) {
      this.end(`GPT-Live unavailable: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    this.deps.log(`live ${this.id}: session ${created.sessionId} for ${this.deps.thread.title} created in ${String(this.deps.clock.now() - this.startedAt)} ms`);
    if (!this.ended) this.deps.send({ t: "live.answer", callId: this.id, agent: this.agent, sessionId: created.sessionId, sdp: created.answer });
    let sideband: Sideband;
    try {
      sideband = await this.deps.api.attach(created.sessionId, {
        event: (event) => {
          this.event(event);
        },
        closed: (reason) => {
          this.sideband = null;
          this.end(reason);
        },
      });
    } catch (error) {
      this.end(`no sideband: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    this.sideband = sideband;
    if (this.ended) {
      // The phone hung up while the sideband was opening: close the session it may never join.
      this.close();
      return;
    }
    this.deps.log(`live ${this.id}: sideband attached at +${String(this.deps.clock.now() - this.startedAt)} ms`);
    // The greeting is in the startup input too; the docs ask for it once more after start.
    sideband.send({ type: "session.commentary.append", event_id: `${this.id}-greet`, delegation_id: null, content: `Greet Isaac now as ${this.deps.thread.title} in at most four words, then pause and listen.` });
    this.cancelCap = this.deps.clock.after(MAX_LIVE_CALL_MS, () => {
      this.end(`call reached ${String(MAX_LIVE_CALL_MS / 60_000)} minutes`);
    });
    this.lastClock = clockLine(this.deps.clock.now());
    this.tick();
    this.setState("listening");
  }

  /**
   * Every TICK_MS while the assistant works: how long it has been at it, as quiet context the
   * voice uses if Isaac asks.
   */
  private tick(): void {
    this.cancelTick = this.deps.clock.after(TICK_MS, () => {
      const sideband = this.sideband;
      if (this.ended || sideband === null) return;
      const now = this.deps.clock.now();
      if (this.awaiting && this.delegation !== null) {
        sideband.send({ type: "session.thinking.append", event_id: `${this.id}-progress-${String(now)}`, delegation_id: this.delegation, content: `${this.deps.thread.title} is still working on it (${String(Math.round((now - this.turnAt) / 1000))} s so far). Background note; only mention it if Isaac asks.` });
      }
      this.tick();
    });
  }

  /** Hangs up (the phone, its socket gone for good, or a failure with `error`). */
  end(error?: string, fallback = false): void {
    if (this.ended) return;
    this.ended = true;
    this.cancelGrace?.();
    this.cancelCap?.();
    this.cancelTick?.();
    for (const wake of this.transcriptWaiters) wake();
    this.transcriptWaiters = [];
    this.close();
    this.deps.log(`live ${this.id}: ended after ${String(Math.round((this.deps.clock.now() - this.startedAt) / 1000))} s${error === undefined ? "" : ` (${error})`}`);
    this.deps.send({ t: "live.state", callId: this.id, agent: this.agent, state: "ended", ...(error === undefined ? {} : { error }), ...(fallback ? { fallback } : {}) });
    this.state = "ended";
    this.deps.onEnded();
  }

  /** Closes the session through the sideband, waiting a moment for its final usage. */
  private close(): void {
    const sideband = this.sideband;
    if (sideband === null) return;
    sideband.send({ type: "session.close", event_id: `${this.id}-close` });
    const cancel = this.deps.clock.after(CLOSE_WAIT_MS, () => {
      this.closing = null;
      sideband.close();
    });
    this.closing = () => {
      cancel();
      sideband.close();
    };
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

  private event(event: LiveEvent): void {
    switch (event.type) {
      case "session.input_transcript.delta": {
        const delta = typeof event["delta"] === "string" ? event["delta"] : "";
        const startMs = typeof event["start_ms"] === "number" ? event["start_ms"] : 0;
        const endMs = typeof event["end_ms"] === "number" ? event["end_ms"] : startMs;
        const now = this.deps.clock.now();
        // A new utterance: refresh the time while Isaac talks, so "what time is it" later in the
        // call is answered right. Appended between his turns it made the voice announce the time.
        if (now - this.lastHeardAt >= UTTERANCE_GAP_MS) {
          const line = clockLine(now);
          if (line !== this.lastClock) {
            this.lastClock = line;
            this.sideband?.send({ type: "session.thinking.append", event_id: `${this.id}-clock-${String(now)}`, delegation_id: null, content: `${line} Background note; only use it if Isaac asks about the time.` });
          }
        }
        this.lastHeardAt = now;
        this.heard.push({ text: delta, startMs, endMs });
        for (const wake of this.transcriptWaiters) wake();
        this.transcriptWaiters = [];
        return;
      }
      case "session.output_transcript.delta": {
        // What Isaac said before the voice answered him itself is dealt with: a later delegation
        // hands over only what came after.
        const delta = typeof event["delta"] === "string" ? event["delta"] : "";
        const startMs = typeof event["start_ms"] === "number" ? event["start_ms"] : 0;
        const endMs = typeof event["end_ms"] === "number" ? event["end_ms"] : startMs;
        if (startMs - this.voiceRun.endMs > VOICE_RUN_GAP_MS) this.voiceRun = { startMs, endMs, words: 0 };
        this.voiceRun.endMs = endMs;
        this.voiceRun.words += delta.split(/\s+/).filter((word) => word !== "").length;
        if (this.voiceRun.words >= VOICE_ANSWER_WORDS) {
          const runStart = this.voiceRun.startMs;
          // Words Isaac started before the voice answered belong to that answer; words he began
          // while it spoke (talking over it) are still open.
          const after = this.heard.findIndex((piece) => piece.startMs >= runStart);
          this.handedOver = Math.max(this.handedOver, after === -1 ? this.heard.length : after);
        }
        return;
      }
      case "session.delegation.created": {
        const delegation = event["delegation"];
        const id = typeof delegation === "object" && delegation !== null && "id" in delegation && typeof delegation.id === "string" ? delegation.id : null;
        const offset = typeof event["offset_ms"] === "number" ? event["offset_ms"] : 0;
        if (id !== null) void this.delegate(id, offset);
        return;
      }
      case "session.closed": {
        const usage = event["usage"];
        const seconds = typeof usage === "object" && usage !== null && "seconds" in usage && typeof usage.seconds === "number" ? usage.seconds : null;
        this.deps.log(`live ${this.id}: session closed (${typeof event["reason"] === "string" ? event["reason"] : "no reason"})${seconds === null ? "" : `, ${String(seconds)} s billed`}`);
        if (this.closing !== null) {
          this.closing();
          this.closing = null;
        } else {
          this.sideband?.close();
        }
        this.sideband = null;
        this.end();
        return;
      }
      case "error":
        this.deps.log(`live ${this.id}: GPT-Live error ${JSON.stringify(event["error"] ?? event).slice(0, 400)}`);
        return;
      default:
        return;
    }
  }

  /** The voice asked for help: Isaac's words not yet dealt with go to the assistant. */
  private async delegate(id: string, offsetMs: number): Promise<void> {
    const asked = this.deps.clock.now();
    // Taken now: the voice's acknowledgement that follows must not mark these words as answered.
    const from = this.handedOver;
    // The words that led to the delegation can arrive just after it.
    while (!this.ended && (this.heard.at(-1)?.endMs ?? 0) < offsetMs && this.deps.clock.now() - asked < TRANSCRIPT_WAIT_MS) {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      const wake = (): void => {
        resolve(undefined);
      };
      this.transcriptWaiters.push(wake);
      const cancel = this.deps.clock.after(TRANSCRIPT_WAIT_MS - (this.deps.clock.now() - asked), wake);
      await promise;
      cancel();
    }
    const sideband = this.sideband;
    if (this.ended || sideband === null) return;
    const text = this.heard
      .slice(from)
      .map((piece) => piece.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    this.handedOver = this.heard.length;
    this.delegation = id;
    if (text === "") {
      this.deps.log(`live ${this.id}: delegation ${id} with no words heard`);
      sideband.send({ type: "session.thinking.append", event_id: `${id}-empty`, delegation_id: id, content: "No request reached the assistant; ask Isaac to say it again." });
      return;
    }
    this.talking = true;
    this.awaiting = true;
    this.sawWorking = false;
    this.replied = false;
    const turn = (this.turnSeq += 1);
    this.turnAt = this.deps.clock.now();
    this.deps.log(`live ${this.id}: delegation ${id} "${text}" (transcript wait ${String(this.turnAt - asked)} ms)`);
    this.setState("thinking", text);
    this.cancelGrace?.();
    this.cancelGrace = this.deps.clock.after(TURN_START_GRACE_MS, () => {
      this.cancelGrace = null;
      if (this.awaiting && !this.sawWorking) this.turnDone();
    });
    try {
      await this.deps.thread.turn(voiceTurn(text));
    } catch (error) {
      // A newer delegation owns the call now; a hung-up call ignores this (setState and the closed sideband are no-ops).
      if (turn !== this.turnSeq) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`live ${this.id}: turn not delivered: ${message}`);
      sideband.send({ type: "session.commentary.append", event_id: `${id}-failed`, delegation_id: id, content: `${this.deps.thread.title} could not be reached just now (${message.slice(0, 200)}). Say so briefly.` });
      this.turnDone();
    }
  }

  private turnDone(): void {
    this.awaiting = false;
    this.cancelGrace?.();
    this.cancelGrace = null;
    this.setState("listening");
  }

  /** A reply row of the assistant's: once its spoken part is final, the voice gets it to say. */
  private reply(id: string, text: string, settled: boolean): void {
    if (this.ignored.has(id) || this.said.has(id)) return;
    if (!this.talking) {
      this.ignored.add(id);
      return;
    }
    if (!settled && !spokenPartComplete(text)) return;
    this.said.add(id);
    if (text.trim() === SILENCE_MARKER) return;
    const spoken = plainSpeech(text, false).slice(0, MAX_COMMENTARY_CHARS);
    if (spoken === "" || this.sideband === null || this.delegation === null) return;
    if (!this.replied) {
      this.replied = true;
      this.deps.log(`live ${this.id}: first reply handed to the voice at +${String(this.deps.clock.now() - this.turnAt)} ms`);
    }
    this.sideband.send({ type: "session.commentary.append", event_id: `${id}-say`, delegation_id: this.delegation, content: spoken });
  }

  private setState(state: LiveState, text?: string): void {
    if (this.ended || (state === this.state && text === this.stateText)) return;
    this.state = state;
    this.stateText = text;
    this.deps.send({ t: "live.state", callId: this.id, agent: this.agent, state, ...(text === undefined ? {} : { text }) });
  }
}
