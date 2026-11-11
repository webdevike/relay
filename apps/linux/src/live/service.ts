// The host's GPT-Live calls, at most one per socket. The session hands it the phone's `live.*`
// frames and the server every provider change. The audio runs phone <-> OpenAI without the host,
// but a call whose socket closes is not left running: it waits LIVE_RECONNECT_GRACE_MS for the
// phone to reconnect and claim it (`live.resume`), then ends, closing the GPT-Live session. The
// session also ends when the phone hangs up, OpenAI drops it, or MAX_LIVE_CALL_MS passes. Without
// an OpenAI key every `live.start` is answered with `ended` + `fallback`, and the phone uses the
// local `call.*` call instead.

import { LIVE_RECONNECT_GRACE_MS } from "@relay/protocol";
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
  /** The call each open socket has. */
  private readonly bySink = new Map<FrameSink, LiveCall>();
  /** Every call still running, by call id, and the socket it reports to (null while it has none). */
  private readonly running = new Map<string, { readonly call: LiveCall; sink: FrameSink | null; cancelGrace: (() => void) | null }>();

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
        const id = message.callId;
        const next: LiveCall = new LiveCall({
          callId: id,
          thread,
          api: this.deps.api,
          voice: this.deps.voice(message.agent),
          send: (frame) => {
            this.running.get(id)?.sink?.send(frame);
          },
          clock: this.deps.clock,
          log: this.deps.log,
          onEnded: () => {
            const entry = this.running.get(id);
            if (entry?.call !== next) return;
            entry.cancelGrace?.();
            this.running.delete(id);
            if (entry.sink !== null && this.bySink.get(entry.sink) === next) this.bySink.delete(entry.sink);
          },
        });
        this.bySink.set(sink, next);
        this.running.set(id, { call: next, sink, cancelGrace: null });
        this.deps.log(`live ${id}: calling ${thread.title}`);
        void next.start(message.sdp);
        return;
      }
      case "live.end":
        if (call?.id === message.callId) call.end(message.reason === undefined ? undefined : `phone: ${message.reason}`);
        else this.running.get(message.callId)?.call.end(message.reason === undefined ? undefined : `phone: ${message.reason}`);
        return;
      case "live.resume": {
        const entry = this.running.get(message.callId);
        if (entry === undefined) {
          sink.send({ t: "live.state", callId: message.callId, agent: message.agent, state: "ended", error: "The call ended while the phone was away" });
          return;
        }
        entry.cancelGrace?.();
        entry.cancelGrace = null;
        if (entry.sink !== null && entry.sink !== sink && this.bySink.get(entry.sink) === entry.call) this.bySink.delete(entry.sink);
        const other = this.bySink.get(sink);
        if (other !== undefined && other !== entry.call) other.end("phone resumed another call");
        entry.sink = sink;
        this.bySink.set(sink, entry.call);
        this.deps.log(`live ${entry.call.id}: phone reconnected`);
        entry.call.resendState();
        return;
      }
    }
  }

  /** The socket closed: its call waits LIVE_RECONNECT_GRACE_MS for the phone to claim it, then ends. */
  drop(sink: FrameSink): void {
    const call = this.bySink.get(sink);
    if (call === undefined) return;
    this.bySink.delete(sink);
    const entry = this.running.get(call.id);
    if (entry?.call !== call || entry.sink !== sink) return;
    entry.sink = null;
    this.deps.log(`live ${call.id}: phone socket closed; ending the call unless the phone is back within ${String(LIVE_RECONNECT_GRACE_MS / 1000)} s`);
    entry.cancelGrace = this.deps.clock.after(LIVE_RECONNECT_GRACE_MS, () => {
      entry.cancelGrace = null;
      if (entry.sink === null) call.end(`phone gone for ${String(LIVE_RECONNECT_GRACE_MS / 1000)} s`);
    });
  }

  observe(change: AgentProviderChange): void {
    for (const { call } of [...this.running.values()]) call.observe(change);
  }
}
