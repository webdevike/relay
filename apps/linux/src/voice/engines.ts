// The one seam voice engines plug into. An engine is provided to the host as an Effect `Layer` of
// the `VoiceEngines` service; `main.ts` resolves the layer named by the host config once and hands
// the service to `LiveService` and `CallService`. The union is tagged by transport on purpose: GPT-Live
// is phone WebRTC direct to OpenAI plus a host sideband, a PCM engine takes the phone's `call.*`
// frames over the host WebSocket. Callers branch on `transport`, never on a provider id.
//
// A new provider on a supported transport adds a `<provider>.ts` exporting a layer, one literal in
// host-config.ts `ProviderId`, and one entry in `VOICE_ENGINE_LAYERS`.

import { Context, Effect, Layer } from "effect";
import type { AgentProviderChange } from "../seams";
import type { CallDeps } from "../call/call";
import { deepgramLayer } from "../call/deepgramCall";
import { type HostConfig, type ProviderId, DEFAULT_PROVIDER } from "../host-config";
import type { LiveApi } from "../live/openai";
import { OpenAiLive, openAiKey } from "../live/openai";

/** What a call needs from any engine, whatever the transport. */
export interface CallLike {
  readonly id: string;
  audio(pcm: string): void;
  mute(muted: boolean): void;
  end(error?: string): void;
  observe(change: AgentProviderChange): void;
}

/** What a PCM engine gets per call: the local call's deps without the local speech stack. */
export type PcmCallDeps = Omit<CallDeps, "voice">;

/** One call on a PCM engine. */
export interface PcmCall extends CallLike {
  /**
   * Opens the engine's session. Resolves false when it never connected and sent the phone nothing
   * (no `call.state`, no `onEnded`), so the service can fall back to the local call silently.
   */
  start(): Promise<boolean>;
}

export type PcmOpen = (deps: PcmCallDeps) => PcmCall;

export interface WebrtcSidebandEngine {
  readonly id: string;
  readonly transport: "webrtc-sideband";
  /** null when the host has no key. */
  readonly api: LiveApi | null;
}

export interface PcmWebSocketEngine {
  readonly id: string;
  readonly transport: "pcm-websocket";
  /** null when the host has no key. */
  readonly open: PcmOpen | null;
}

export type VoiceEngine = WebrtcSidebandEngine | PcmWebSocketEngine;

export class VoiceEngines extends Context.Service<
  VoiceEngines,
  {
    /** The engine assistant `agent` calls on. */
    select(agent: string): VoiceEngine;
  }
>()("relay/voice/VoiceEngines") {}

export type VoiceEngineSelector = Context.Service.Shape<typeof VoiceEngines>;

export interface EngineEnv {
  readonly agentHome: string | null;
  readonly env: NodeJS.ProcessEnv;
}

export type EngineLayer = (env: EngineEnv) => Layer.Layer<VoiceEngines>;

/** A layer that gives every agent `engine`. */
export function engineLayer(engine: VoiceEngine): Layer.Layer<VoiceEngines> {
  return Layer.succeed(VoiceEngines, VoiceEngines.of({ select: () => engine }));
}

export function gptLiveLayer(env: EngineEnv): Layer.Layer<VoiceEngines> {
  return Layer.sync(VoiceEngines, () => {
    const key = openAiKey(env.agentHome, env.env);
    const engine: WebrtcSidebandEngine = { id: "gpt-live", transport: "webrtc-sideband", api: key === null ? null : new OpenAiLive(key) };
    return { select: () => engine };
  });
}

/** Total over `ProviderId`: a provider without an entry is a type error. */
export const VOICE_ENGINE_LAYERS: Readonly<Record<ProviderId, EngineLayer>> = {
  "gpt-live": gptLiveLayer,
  deepgram: deepgramLayer,
};

/** The service a layer provides. Layers build synchronously; calls open their sessions later, in their own scope. */
export function resolveVoiceEngines(layer: Layer.Layer<VoiceEngines>): VoiceEngineSelector {
  return Effect.runSync(Effect.scoped(Layer.build(layer).pipe(Effect.map((context) => Context.get(context, VoiceEngines)))));
}

/**
 * The host's engines: provider `$RELAY_VOICE_PROVIDER`, else host.json `voice.provider`, else the
 * default, looked up in `registry` and resolved once.
 */
export function composeVoiceEngines(
  config: HostConfig | null,
  env: EngineEnv,
  registry: Readonly<Record<string, EngineLayer>> = VOICE_ENGINE_LAYERS,
): VoiceEngineSelector {
  const fromEnv = env.env["RELAY_VOICE_PROVIDER"]?.trim();
  const id = fromEnv !== undefined && fromEnv !== "" ? fromEnv : (config?.voice?.provider ?? DEFAULT_PROVIDER);
  const layer = Object.hasOwn(registry, id) ? registry[id] : undefined;
  if (layer === undefined) throw new Error(`Unknown voice provider "${id}"; known: ${Object.keys(registry).join(", ")}`);
  return resolveVoiceEngines(layer(env));
}
