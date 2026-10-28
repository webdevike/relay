// The host's GPT-Live calls, at most one per socket. The session hands it the phone's `live.*`
// frames and the server every provider change. A socket that closes does not end its call: the
// audio runs phone <-> OpenAI without it, and the session ends when the phone closes it, OpenAI
// drops it, or MAX_LIVE_CALL_MS passes. Without an OpenAI key every `live.start` is answered with
// `ended` + `fallback`, and the phone uses the local `call.*` call instead.

import type { AgentProviderChange, FrameSink, LiveClientMessage, LiveRelaying } from "../seams";
import type { SessionClock } from "../session";
import { LiveCall, type LiveThread } from "./call";
import type { LiveApi } from "./openai";

export interface LiveServiceDeps {
  /** The thread of assistant `agent`; undefined for an agent the registry does not have. */
  readonly thread: (agent: string) => LiveThread | undefined;
  /** null when the host has no OpenAI key. */
  readonly api: LiveApi | null;
  /** GPT-Live voice of assistant `agent`. */
  readonly voice: (agent: string) => string;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

export class LiveService implements LiveRelaying {
  /** The call each open socket started. */
  private readonly bySink = new Map<FrameSink, LiveCall>();
  /** Every call still running, including those whose socket has closed. */
  private readonly running = new Set<LiveCall>();
  /** Sockets that closed; their calls no longer report to them. */
  private readonly gone = new WeakSet<FrameSink>();

  constructor(private readonly deps: LiveServiceDeps) {}

  receive(sink: FrameSink, message: LiveClientMessage): void {
    const call = this.bySink.get(sink);
    switch (message.t) {
      case "live.start": {
        call?.end("phone started another call");
        const thread = this.deps.thread(message.agent);
        if (thread === undefined) {
          sink.send({ t: "live.state", callId: message.callId, agent: message.agent, state: "ended", error: `No assistant named ${message.agent} on this host` });
          return;
        }
        if (this.deps.api === null) {
          this.deps.log(`live ${message.callId}: no OpenAI key on this host; the phone falls back to a local call`);
          sink.send({ t: "live.state", callId: message.callId, agent: message.agent, state: "ended", error: "No OpenAI key on this host", fallback: true });
          return;
        }
        const next: LiveCall = new LiveCall({
          callId: message.callId,
          thread,
          api: this.deps.api,
          voice: this.deps.voice(message.agent),
          send: (frame) => {
            if (!this.gone.has(sink)) sink.send(frame);
          },
          clock: this.deps.clock,
          log: this.deps.log,
          onEnded: () => {
            this.running.delete(next);
            if (this.bySink.get(sink) === next) this.bySink.delete(sink);
          },
        });
        this.bySink.set(sink, next);
        this.running.add(next);
        this.deps.log(`live ${message.callId}: calling ${thread.title}`);
        void next.start(message.sdp);
        return;
      }
      case "live.end":
        if (call?.id === message.callId) call.end(message.reason === undefined ? undefined : `phone: ${message.reason}`);
        return;
    }
  }

  /** The socket closed: its call keeps running (the audio does not need it) but stops reporting to it. */
  drop(sink: FrameSink): void {
    this.gone.add(sink);
    const call = this.bySink.get(sink);
    if (call === undefined) return;
    this.bySink.delete(sink);
    this.deps.log(`live ${call.id}: phone socket closed; the call goes on until the phone or OpenAI ends it`);
  }

  observe(change: AgentProviderChange): void {
    for (const call of [...this.running]) call.observe(change);
  }
}
