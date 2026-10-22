// The host's calls: at most one per socket, each a `VoiceCall` with one assistant thread. The
// session hands it the phone's `call.*` frames and the server every provider change; a socket
// that closes hangs its call up.

import type { AgentProviderChange, CallClientMessage, CallRelaying, FrameSink } from "../seams";
import type { SessionClock } from "../session";
import { type CallThread, VoiceCall, type VoiceStack } from "./call";

export interface CallServiceDeps {
  /** The thread of assistant `agent`; undefined for an agent the registry does not have. */
  readonly thread: (agent: string) => CallThread | undefined;
  readonly voice: VoiceStack;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

export class CallService implements CallRelaying {
  private readonly calls = new Map<FrameSink, VoiceCall>();

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
        const next: VoiceCall = new VoiceCall({
          callId: message.callId,
          thread,
          voice: this.deps.voice,
          send: (frame) => {
            sink.send(frame);
          },
          clock: this.deps.clock,
          log: this.deps.log,
          onEnded: () => {
            if (this.calls.get(sink) === next) this.calls.delete(sink);
          },
        });
        this.calls.set(sink, next);
        this.deps.log(`call ${message.callId}: calling ${thread.title}`);
        void next.start();
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

  warm(): void {
    this.deps.voice.warm();
  }

  drop(sink: FrameSink): void {
    this.calls.get(sink)?.end();
  }

  observe(change: AgentProviderChange): void {
    for (const call of [...this.calls.values()]) call.observe(change);
  }
}
