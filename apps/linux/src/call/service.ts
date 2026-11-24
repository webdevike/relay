// The host's calls: at most one per socket, each with one assistant thread: a PCM engine's call when
// the host's engine is `pcm-websocket` and opens, else the local `VoiceCall`. The session hands it
// the phone's `call.*` frames and the server every provider change; a socket that closes hangs its
// call up.

import type { ServerMessage } from "@relay/protocol";
import type { AgentProviderChange, CallClientMessage, CallRelaying, FrameSink } from "../seams";
import type { SessionClock } from "../session";
import type { CallLike, PcmOpen, VoiceEngineSelector } from "../voice/engines";
import { type CallDeps, type CallThread, VoiceCall, type VoiceStack } from "./call";

export interface CallServiceDeps {
  /** The thread of assistant `agent`; undefined for an agent the registry does not have. */
  readonly thread: (agent: string) => CallThread | undefined;
  /** The engines of this host; a PCM engine's call is tried first. */
  readonly engines: VoiceEngineSelector;
  /** The local speech stack; null when the host has none. */
  readonly voice: VoiceStack | null;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /**
   * The phone answered the ring of "call me when it's done" request `request` (`call.start` with
   * `request`): that call's opener, or undefined when the request is not ringing (an ordinary call).
   */
  readonly answer?: (request: string, agent: string) => CallDeps["opener"];
}

export class CallService implements CallRelaying {
  private readonly calls = new Map<FrameSink, CallLike>();

  constructor(private readonly deps: CallServiceDeps) {}

  receive(sink: FrameSink, message: CallClientMessage): void {
    const call = this.calls.get(sink);
    switch (message.t) {
      case "call.start": {
        call?.end();
        const thread = this.deps.thread(message.agent);
        if (thread === undefined) {
          sink.send({ t: "call.state", callId: message.callId, agent: message.agent, state: "ended", error: `No assistant named ${message.agent} on this host` });
          return;
        }
        this.deps.log(`call ${message.callId}: calling ${thread.title}`);
        const opener = message.request === undefined ? undefined : this.deps.answer?.(message.request, thread.id);
        if (message.request !== undefined)
          this.deps.log(`call ${message.callId}: ${opener === undefined ? `${message.request} is not ringing; an ordinary call` : `opens with "${opener.greeting}"`}`);
        const engine = this.deps.engines.select(message.agent);
        const open = engine.transport === "pcm-websocket" ? engine.open : null;
        if (open === null) this.startLocal(sink, message.callId, thread, opener);
        else this.startPcm(sink, message.callId, thread, open, opener);
        return;
      }
      case "call.audio":
        if (call?.id === message.callId) call.audio(message.pcm);
        return;
      case "call.mute":
        if (call?.id === message.callId) call.mute(message.muted);
        return;
      case "call.end":
        if (call?.id === message.callId) call.end(message.reason === undefined ? undefined : `phone: ${message.reason}`);
        return;
    }
  }

  /** Registers the call `make` builds on `sink`; its `onEnded` frees the socket only while it is still that socket's call. */
  private register<C extends CallLike>(sink: FrameSink, callId: string, thread: CallThread, opener: CallDeps["opener"], make: (deps: Omit<CallDeps, "voice">) => C): C {
    const next: C = make({
      callId,
      thread,
      ...(opener === undefined ? {} : { opener }),
      send: (frame: ServerMessage) => {
        sink.send(frame);
      },
      clock: this.deps.clock,
      log: this.deps.log,
      onEnded: () => {
        if (this.calls.get(sink) === next) this.calls.delete(sink);
      },
    });
    this.calls.set(sink, next);
    return next;
  }

  /** When the PCM call never connects, the local call takes its place. */
  private startPcm(sink: FrameSink, callId: string, thread: CallThread, open: PcmOpen, opener: CallDeps["opener"]): void {
    const next = this.register(sink, callId, thread, opener, open);
    void next.start().then((connected) => {
      if (connected || this.calls.get(sink) !== next) return;
      this.calls.delete(sink);
      this.startLocal(sink, callId, thread, opener);
    });
  }

  private startLocal(sink: FrameSink, callId: string, thread: CallThread, opener: CallDeps["opener"]): void {
    const voice = this.deps.voice;
    if (voice === null) {
      sink.send({ t: "call.state", callId, agent: thread.id, state: "ended", error: "This host cannot take calls" });
      return;
    }
    const local = this.register(sink, callId, thread, opener, (deps) => new VoiceCall({ ...deps, voice }));
    void local.start();
  }

  warm(): void {
    this.deps.voice?.warm();
  }

  drop(sink: FrameSink): void {
    this.calls.get(sink)?.end();
  }

  observe(change: AgentProviderChange): void {
    for (const call of [...this.calls.values()]) call.observe(change);
  }
}
