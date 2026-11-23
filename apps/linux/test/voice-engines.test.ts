import { Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentSession, ServerMessage } from "@relay/protocol";
import type { CallThread } from "../src/call/call";
import { CallService } from "../src/call/service";
import { type HostConfig, ProviderId } from "../src/host-config";
import type { LiveApi } from "../src/live/openai";
import { LiveService } from "../src/live/service";
import type { FrameSink } from "../src/seams";
import type { SessionClock } from "../src/session";
import {
  composeVoiceEngines,
  engineLayer,
  type EngineEnv,
  type EngineLayer,
  gptLiveLayer,
  type PcmCall,
  type PcmCallDeps,
  resolveVoiceEngines,
  VOICE_ENGINE_LAYERS,
  VoiceEngines,
} from "../src/voice/engines";

const clock: SessionClock = { now: () => 0, after: () => () => undefined };
const NO_KEY: EngineEnv = { agentHome: null, env: {} };
const WITH_KEY: EngineEnv = { agentHome: null, env: { OPENAI_API_KEY: "sk-synthetic" } };

const thread: CallThread = {
  id: "nova",
  title: "Nova",
  session: (): AgentSession | undefined => undefined,
  turn: () => Promise.resolve(),
};

function phone(): { sink: FrameSink; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return { sent, sink: { send: (message) => sent.push(message), close: () => undefined } };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** A PCM call that records what the service gives it. */
class ScriptedCall implements PcmCall {
  readonly audioIn: string[] = [];
  readonly ended: (string | undefined)[] = [];
  constructor(
    readonly id: string,
    private readonly connects: boolean,
  ) {}
  start(): Promise<boolean> {
    return Promise.resolve(this.connects);
  }
  audio(pcm: string): void {
    this.audioIn.push(pcm);
  }
  mute(): void {
    return;
  }
  end(error?: string): void {
    this.ended.push(error);
  }
  observe(): void {
    return;
  }
}

function scriptedRegistry(connects: boolean): { registry: Record<string, EngineLayer>; opened: ScriptedCall[]; deps: PcmCallDeps[] } {
  const opened: ScriptedCall[] = [];
  const deps: PcmCallDeps[] = [];
  const layer: EngineLayer = () =>
    engineLayer({
      id: "scripted",
      transport: "pcm-websocket",
      open: (d) => {
        deps.push(d);
        const call = new ScriptedCall(d.callId, connects);
        opened.push(call);
        return call;
      },
    });
  return { registry: { scripted: layer }, opened, deps };
}

const SCRIPTED: EngineEnv = { agentHome: null, env: { RELAY_VOICE_PROVIDER: "scripted" } };

describe("voice engine composition", () => {
  it("defaults to GPT-Live, keyed from the environment or absent", () => {
    const withKey = composeVoiceEngines(null, WITH_KEY).select("nova");
    expect(withKey).toMatchObject({ id: "gpt-live", transport: "webrtc-sideband" });
    expect(withKey.transport === "webrtc-sideband" && withKey.api !== null).toBe(true);
    const without = composeVoiceEngines(null, NO_KEY).select("nova");
    expect(without.transport === "webrtc-sideband" && without.api).toBeNull();
  });

  it("registers a layer for every provider id", () => {
    expect(Object.keys(VOICE_ENGINE_LAYERS).sort()).toEqual([...ProviderId.options].sort());
  });

  it("takes the provider from $RELAY_VOICE_PROVIDER over host.json, and rejects an unknown one", () => {
    const { registry } = scriptedRegistry(true);
    const both: Record<string, EngineLayer> = { ...registry, "gpt-live": gptLiveLayer };
    const config: HostConfig = { features: {}, voice: { provider: "gpt-live" } };
    expect(composeVoiceEngines(config, SCRIPTED, both).select("nova").id).toBe("scripted");
    expect(composeVoiceEngines(config, NO_KEY, both).select("nova").id).toBe("gpt-live");
    expect(() => composeVoiceEngines(null, { agentHome: null, env: { RELAY_VOICE_PROVIDER: "constructor" } })).toThrow('Unknown voice provider "constructor"');
  });

  it("resolves a plain layer of VoiceEngines", () => {
    const layer = Layer.succeed(VoiceEngines, VoiceEngines.of({ select: () => ({ id: "x", transport: "pcm-websocket", open: null }) }));
    expect(resolveVoiceEngines(layer).select("nova").id).toBe("x");
  });
});

describe("callers on a substituted engine", () => {
  function calls(registry: Record<string, EngineLayer>, voice: ConstructorParameters<typeof CallService>[0]["voice"]): CallService {
    return new CallService({ thread: () => thread, engines: composeVoiceEngines(null, SCRIPTED, registry), voice, clock, log: () => undefined });
  }

  it("runs call.start on a third pcm layer without a local voice stack, and routes the call's frames to it", () => {
    const { registry, opened } = scriptedRegistry(true);
    const service = calls(registry, null);
    const p = phone();
    service.receive(p.sink, { t: "call.start", callId: "c1", agent: "nova" });
    expect(opened.map((call) => call.id)).toEqual(["c1"]);
    service.receive(p.sink, { t: "call.audio", callId: "c1", pcm: "AAAA" });
    expect(opened[0]?.audioIn).toEqual(["AAAA"]);
    service.drop(p.sink);
    expect(opened[0]?.ended).toEqual([undefined]);
    expect(p.sent).toEqual([]);
  });

  it("falls back to the local call, silently, when the engine never connects", async () => {
    const { registry, opened } = scriptedRegistry(false);
    let earsAsked = 0;
    const voice = {
      ears: () => {
        earsAsked += 1;
        return Promise.reject(new Error("no models"));
      },
      filler: () => Promise.resolve(""),
      speak: (): AsyncIterable<Uint8Array> => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }),
      warm: () => undefined,
    };
    const service = calls(registry, voice);
    const p = phone();
    service.receive(p.sink, { t: "call.start", callId: "c1", agent: "nova" });
    await settle();
    expect(opened).toHaveLength(1);
    expect(earsAsked).toBe(1);
    expect(p.sent.flatMap((m) => (m.t === "call.state" ? [m.state] : []))).toEqual(["connecting", "ended"]);
  });

  it("answers ended when the engine never connects and the host has no local voice", async () => {
    const { registry } = scriptedRegistry(false);
    const service = calls(registry, null);
    const p = phone();
    service.receive(p.sink, { t: "call.start", callId: "c1", agent: "nova" });
    await settle();
    expect(p.sent).toEqual([{ t: "call.state", callId: "c1", agent: "nova", state: "ended", error: "This host cannot take calls" }]);
  });

  it("answers ended with today's text on a keyless default host with no local voice", () => {
    const service = new CallService({ thread: () => thread, engines: composeVoiceEngines(null, NO_KEY), voice: null, clock, log: () => undefined });
    const p = phone();
    service.receive(p.sink, { t: "call.start", callId: "c1", agent: "nova" });
    expect(p.sent).toEqual([{ t: "call.state", callId: "c1", agent: "nova", state: "ended", error: "This host cannot take calls" }]);
  });

  it("runs live.start on a test webrtc layer and declines it under pcm", async () => {
    const created: string[] = [];
    const api: LiveApi = {
      create: (_config, offer) => {
        created.push(offer);
        return Promise.reject(new Error("synthetic stop"));
      },
      attach: () => Promise.reject(new Error("unused")),
    };
    const webrtc: Record<string, EngineLayer> = { sip: () => engineLayer({ id: "sip", transport: "webrtc-sideband", api }) };
    const liveThread = { ...thread, rows: () => Promise.resolve([]), memory: () => Promise.resolve(null) };
    const env: EngineEnv = { agentHome: null, env: { RELAY_VOICE_PROVIDER: "sip" } };
    const live = new LiveService({ thread: () => liveThread, engines: composeVoiceEngines(null, env, webrtc), voice: () => "marin", clock, log: () => undefined });
    live.receive(phone().sink, { t: "live.start", callId: "l1", agent: "nova", sdp: "v=0" });
    await settle();
    expect(created).toEqual(["v=0"]);

    const pcm = new LiveService({ thread: () => liveThread, engines: composeVoiceEngines(null, SCRIPTED, scriptedRegistry(true).registry), voice: () => "marin", clock, log: () => undefined });
    const p = phone();
    pcm.receive(p.sink, { t: "live.start", callId: "l2", agent: "nova", sdp: "v=0" });
    expect(p.sent).toEqual([{ t: "live.state", callId: "l2", agent: "nova", state: "ended", error: "This host uses PCM calls", fallback: true }]);
  });
});
