// One Deepgram Voice Agent call with an assistant, over the phone's PCM `call.*` transport. Deepgram
// bundles the ears, the talking model and the voice; this call is its brain, like `LiveCall` is for
// GPT-Live: the voice hands Isaac's words to the assistant's normal thread through one client-side
// function (`ask_assistant`), the settled reply goes back as a line for the voice to say, and a
// barge-in flushes the phone's playback. The lifecycle is `deepgramCall.machine.ts`; the session
// is `deepgram.ts` (an Effect service whose scope the machine's `session` actor owns).
//
// Contract with `CallService`: `start()` resolves false when the session never opened and the
// phone was sent nothing (the service falls back to the local call); otherwise the call reports its
// states and one `ended`, then `onEnded`.

import { Effect, Fiber, type Layer, Stream } from "effect";
import { type ActorOptions, type AnyActorLogic, createActor, fromCallback, waitFor } from "xstate";
import type { CallState } from "@relay/protocol";
import { z } from "zod";
import { spokenPartComplete, voiceTurn } from "../assistant/voice";
import { clockLine, liveInstructions } from "../live/call";
import { memoryBrief, recentTurns } from "../live/brief";
import type { AgentProviderChange } from "../seams";
import type { SessionClock } from "../session";
import { engineLayer, type EngineEnv, type PcmCall, type PcmCallDeps, type VoiceEngines } from "../voice/engines";
import { TURN_START_GRACE_MS } from "./call";
import { type AgentConfig, type AgentEvent, type AgentSession, DeepgramAgent, deepgramAgentLayer, deepgramKey } from "./deepgram";
import { deepgramCallMachine, type DeepgramCallEvent } from "./deepgramCall.machine";
import { ReplySpeech } from "./speech";

/** The function the voice calls to hand Isaac's request to the assistant. */
export const ASK_ASSISTANT = "ask_assistant";
const GREETING = "Hey, what's up?";
const LIVE_STATES = ["listening", "hearing", "thinking", "speaking"] as const;
const Question = z.object({ question: z.string() });
/** One `call.audio` frame carries at most this many bytes (MAX_CALL_AUDIO_BASE64 of base64, kept sample-aligned). */
const FRAME_BYTES = 48 * 1024;
/** What the voice hears back from `ask_assistant`: stay quiet, the answer arrives as text to say. */
const HANDED_OVER = "Handed to the assistant. Say at most one short first-person line like \"Checking on that.\" and then stay quiet: the answer will be sent to you as text to say.";

/** The voice's prompt: GPT-Live's persona, with delegation through the `ask_assistant` function. */
export function deepgramInstructions(title: string, background: readonly string[]): string {
  return [
    liveInstructions(title),
    `Delegate by calling the ${ASK_ASSISTANT} function with what he asked. Ignore the advice above about the time being told as the call goes on: the time and background below are what you know. The answer comes back later as a line to say; say it directly in your own words.`,
    ...background,
  ].join("\n\n");
}

type MachineClock = NonNullable<ActorOptions<AnyActorLogic>["clock"]>;

/** xstate's timers on the host's session clock. */
function machineClock(clock: SessionClock): MachineClock {
  const cancels = new Map<number, () => void>();
  let next = 0;
  return {
    setTimeout: (fn, ms) => {
      next += 1;
      const id = next;
      cancels.set(id, clock.after(ms, () => {
        cancels.delete(id);
        fn();
      }));
      return id;
    },
    clearTimeout: (id) => {
      cancels.get(id as number)?.();
      cancels.delete(id as number);
    },
  };
}

export class DeepgramCall implements PcmCall {
  readonly id: string;
  private readonly actor;
  private session: AgentSession | null = null;
  private ended = false;
  private muted = false;
  private state: CallState | null = null;
  private stateText: string | undefined;
  private startedAt = 0;
  /** Audio generation; a barge-in moves to the next and the phone drops older audio. */
  private gen = 0;
  private agentSpeaking = false;
  private hearing = false;
  /** Isaac's finals since the last handover. */
  private heardSince: string[] = [];
  private talking = false;
  private awaiting = false;
  private sawWorking = false;
  private replied = false;
  private turnSeq = 0;
  private turnAt = 0;
  private cancelGrace: (() => void) | null = null;
  private readonly replies = new Map<string, ReplySpeech>();
  private readonly ignored = new Set<string>();
  private lastSaid = "";
  /** Lines Deepgram refused (the user was mid-turn); said when the agent is next idle. */
  private readonly refused: string[] = [];

  constructor(
    private readonly deps: PcmCallDeps,
    private readonly agent: Layer.Layer<DeepgramAgent>,
  ) {
    this.id = deps.callId;
    this.actor = createActor(
      deepgramCallMachine.provide({
        actors: {
          session: fromCallback<DeepgramCallEvent>(({ sendBack }) => {
            const fiber = Effect.runFork(this.run(sendBack).pipe(Effect.provide(this.agent)));
            return () => {
              this.session = null;
              Effect.runFork(Fiber.interrupt(fiber));
            };
          }),
        },
      }),
      { clock: machineClock(deps.clock) },
    );
  }

  get agentId(): string {
    return this.deps.thread.id;
  }

  /** The session's whole life in one scope: open, report ready, feed events to the call; interrupting the fiber closes the socket. */
  private run(send: (event: DeepgramCallEvent) => void): Effect.Effect<void, never, DeepgramAgent> {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const config = yield* Effect.promise(() => this.config());
        const session = yield* (yield* DeepgramAgent).open(config);
        this.session = session;
        send({ type: "session.ready" });
        yield* Stream.runForEach(session.events, (event) => Effect.sync(() => {
          this.onEvent(event);
        }));
      }).pipe(Effect.catch((error) => Effect.sync(() => {
        send({ type: "session.failed", reason: error.message });
      }))),
    );
  }

  private async config(): Promise<AgentConfig> {
    const { thread } = this.deps;
    const [rows, memory] = await Promise.all([thread.rows?.().catch(() => []) ?? [], thread.memory?.().catch(() => null) ?? null]);
    const history = recentTurns(rows).flatMap((turn) => (turn.role === "developer" ? [] : [{ role: turn.role, content: turn.text }]));
    const background = [memoryBrief(thread.title, memory), clockLine(this.deps.clock.now())].flatMap((line) => (line === null ? [] : [line]));
    return {
      prompt: deepgramInstructions(thread.title, background),
      greeting: GREETING,
      history,
      functions: [{
        name: ASK_ASSISTANT,
        description: "Hand what Isaac just asked to your assistant side and get the answer back later as text to say.",
        parameters: { type: "object", properties: { question: { type: "string", description: "What Isaac asked, in his words." } }, required: ["question"] },
        defer_until_eot: true,
      }],
    };
  }

  /** Opens the session. Resolves false when it never opened and the phone was sent nothing. */
  async start(): Promise<boolean> {
    this.startedAt = this.deps.clock.now();
    this.actor.subscribe((snapshot) => {
      if (snapshot.status === "done") {
        this.finish(snapshot.matches("unavailable"), snapshot.output.error ?? undefined);
        return;
      }
      for (const live of LIVE_STATES) if (snapshot.matches({ live })) this.setState(live);
    });
    this.actor.start();
    const settled = await waitFor(this.actor, (snapshot) => !snapshot.matches("connecting"), { timeout: Infinity });
    return !settled.matches("unavailable");
  }

  private finish(unavailable: boolean, error: string | undefined): void {
    this.ended = true;
    this.cancelGrace?.();
    if (unavailable) {
      this.deps.log(`call ${this.id}: Deepgram unavailable (${error ?? "unknown"}); falling back`);
      return;
    }
    this.deps.log(`call ${this.id}: ended after ${String(Math.round((this.deps.clock.now() - this.startedAt) / 1000))} s${error === undefined ? "" : ` (${error})`}`);
    this.deps.send({ t: "call.state", callId: this.id, agent: this.agentId, state: "ended", ...(error === undefined ? {} : { error }) });
    this.state = "ended";
    this.deps.onEnded();
  }

  /** Microphone audio from the phone; a muted or not yet connected call sends none (the session pings to stay open). */
  audio(pcm: string): void {
    if (this.ended || this.muted) return;
    this.session?.sendAudio(Buffer.from(pcm, "base64"));
  }

  mute(muted: boolean): void {
    this.muted = muted;
  }

  /** Hangs up (the phone, its socket gone, or a failure with `error`). */
  end(error?: string): void {
    if (this.ended) return;
    this.actor.send({ type: "call.hangup", ...(error === undefined ? {} : { reason: error }) });
  }

  private onEvent(event: AgentEvent): void {
    if (this.ended) return;
    switch (event.t) {
      case "audio":
        // Deepgram does not always announce the greeting with AgentStartedSpeaking: audio is the proof.
        if (!this.agentSpeaking && !this.hearing) {
          this.agentSpeaking = true;
          this.actor.send({ type: "agent.speaking" });
        }
        for (let at = 0; at < event.pcm.byteLength; at += FRAME_BYTES) {
          this.deps.send({ t: "call.audio", callId: this.id, gen: this.gen, pcm: Buffer.from(event.pcm.subarray(at, at + FRAME_BYTES)).toString("base64") });
        }
        return;
      case "user-speaking":
        this.hearing = true;
        this.bargeIn();
        this.actor.send({ type: "user.speaking" });
        return;
      case "agent-speaking":
        this.hearing = false;
        this.agentSpeaking = true;
        this.actor.send({ type: "agent.speaking" });
        return;
      case "agent-audio-done":
        this.agentSpeaking = false;
        this.actor.send({ type: this.awaiting ? "question.asked" : "agent.done" });
        for (const line of this.refused.splice(0)) this.say(line);
        return;
      case "text":
        if (event.role === "user" && event.content.trim() !== "") {
          this.hearing = false;
          this.heardSince.push(event.content.trim());
        }
        return;
      case "function":
        this.delegate(event.id, event.name, event.arguments);
        return;
      case "function-cancelled":
        this.deps.log(`call ${this.id}: Deepgram cancelled a function call`);
        return;
      case "injection-refused":
        if (this.lastSaid !== "") this.refused.push(this.lastSaid);
        return;
      case "warning":
        this.deps.log(`call ${this.id}: Deepgram warning ${event.message.slice(0, 300)}`);
        return;
      case "error":
        this.actor.send({ type: "session.failed", reason: `Deepgram error ${event.message.slice(0, 300)}` });
        return;
      case "closed":
        this.actor.send({ type: "session.closed", reason: "The voice service dropped the call" });
        return;
    }
  }

  /** Isaac talked over the agent: stop the phone's playback, forget the replies being said. */
  private bargeIn(): void {
    if (this.agentSpeaking) {
      this.gen += 1;
      this.deps.send({ t: "call.flush", callId: this.id, gen: this.gen });
      this.agentSpeaking = false;
      this.deps.log(`call ${this.id}: barge-in`);
    }
    for (const id of this.replies.keys()) this.ignored.add(id);
    this.replies.clear();
    this.refused.length = 0;
  }

  /** The voice asked for the assistant: Isaac's words since the last handover go to the thread as a voice turn. */
  private delegate(functionId: string, name: string, args: string): void {
    const respond = (content: string): void => {
      this.session?.sendJson({ type: "FunctionCallResponse", id: functionId, name, content });
    };
    if (name !== ASK_ASSISTANT) {
      respond("Unknown function.");
      return;
    }
    const text = this.heardSince.join(" ") || this.questionOf(args);
    this.heardSince = [];
    if (text === "") {
      respond("No request reached the assistant; ask Isaac to say it again.");
      return;
    }
    respond(HANDED_OVER);
    this.talking = true;
    this.awaiting = true;
    this.sawWorking = false;
    this.replied = false;
    const turn = (this.turnSeq += 1);
    this.turnAt = this.deps.clock.now();
    this.deps.log(`call ${this.id}: heard "${text}"`);
    this.stateText = text;
    this.actor.send({ type: "question.asked" });
    this.cancelGrace?.();
    this.cancelGrace = this.deps.clock.after(TURN_START_GRACE_MS, () => {
      this.cancelGrace = null;
      if (this.awaiting && !this.sawWorking) this.turnDone();
    });
    this.deps.thread.turn(voiceTurn(text)).catch((error: unknown) => {
      if (turn !== this.turnSeq || this.ended) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`call ${this.id}: turn not delivered: ${message}`);
      this.say("Sorry, I couldn't get to that just now.");
      this.turnDone();
    });
  }

  private questionOf(args: string): string {
    try {
      const parsed = Question.safeParse(JSON.parse(args));
      return parsed.success ? parsed.data.question.trim() : "";
    } catch {
      return "";
    }
  }

  private turnDone(): void {
    this.awaiting = false;
    this.cancelGrace?.();
    this.cancelGrace = null;
    if (!this.agentSpeaking && !this.ended) this.actor.send({ type: "agent.done" });
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
    const fresh = speech.next(text, settled || spokenPartComplete(text));
    if (fresh.length === 0) return;
    if (!this.replied) {
      this.replied = true;
      this.deps.log(`call ${this.id}: first reply sentence at +${String(this.deps.clock.now() - this.turnAt)} ms`);
    }
    this.say(fresh.join(" "));
  }

  /** The voice says `line` after whatever it is saying; a refusal (the user is mid-turn) retries when the agent is idle. */
  private say(line: string): void {
    this.lastSaid = line;
    this.session?.sendJson({ type: "InjectAgentMessage", behavior: "queue", message: line });
  }

  private setState(state: CallState): void {
    const text = state === "thinking" ? this.stateText : undefined;
    if (this.ended || (state === this.state && text === this.stateText)) return;
    this.state = state;
    this.deps.send({ t: "call.state", callId: this.id, agent: this.agentId, state, ...(text === undefined ? {} : { text }) });
  }
}

/** Deepgram as a PCM engine: `open` is null without a key (the host then calls on the local stack). */
export function deepgramLayer(env: EngineEnv): Layer.Layer<VoiceEngines> {
  const key = deepgramKey(env.agentHome, env.env);
  return engineLayer({
    id: "deepgram",
    transport: "pcm-websocket",
    open: key === null ? null : (deps) => new DeepgramCall(deps, deepgramAgentLayer(key)),
  });
}
