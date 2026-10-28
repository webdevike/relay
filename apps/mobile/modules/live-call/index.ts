/**
 * Live calls (ios/LiveCallEngine.swift): a GPT-Live voice conversation with an assistant, fully
 * native so the Action Button / lock screen App Intents run it without JS. The app hands the
 * engine its paired hosts (`configure`), starts and ends calls from the thread, and mirrors calls
 * the intents started (`state` events, `current`). Null on a build without the module (older
 * binaries running a newer OTA bundle): callers fall back to the legacy call.
 */
import { requireOptionalNativeModule, type NativeModule } from "expo-modules-core";

export type LiveCallPhase = "connecting" | "listening" | "thinking" | "speaking" | "ended";

export interface LiveCallSnapshot {
  agent: string;
  callId: string;
  state: LiveCallPhase;
  /** What the assistant is working on (`thinking`): Isaac's words, from the host. */
  text?: string;
  /** Isaac's latest words. */
  you?: string;
  /** The assistant's latest spoken words. */
  assistant?: string;
  /** The newest of the two, as the Live Activity shows it. */
  line: string;
  error?: string;
  muted: boolean;
  /** On `ended`: GPT-Live was unavailable and the legacy call starts instead. */
  fallback: boolean;
  /** Epoch ms. */
  startedAt: number;
}

/** A paired host the engine may call through, `url` = `ws://<authority>/relay`. */
export interface LiveCallHost {
  url: string;
  deviceId: string;
  deviceName: string;
  secretHex: string;
  name: string;
}

export interface LiveCallFallback {
  agent: string;
  reason: string;
}

export type LiveCallOutcome = { outcome: "live" | "ended" } | { outcome: "fallback" | "failed"; message: string };

export type LiveCallEvents = {
  /** Every change of the running call, including the final `ended`. */
  state: (snapshot: LiveCallSnapshot) => void;
  /** A call could not go live; a pending fallback is stored for `consumePendingFallback`. */
  fallback: (event: LiveCallFallback) => void;
};

declare class LiveCallNative extends NativeModule<LiveCallEvents> {
  /** Paired hosts, preferred first; kept in the module's own Keychain item (readable on the lock screen). */
  configure(options: { hosts: LiveCallHost[] }): void;
  /** Starts a call with `agent` (ending any other first); resolves once it is live or why not. */
  start(agent: string): Promise<LiveCallOutcome>;
  end(): Promise<void>;
  setMuted(muted: boolean): void;
  current(): LiveCallSnapshot | null;
  /** The fallback a call left for the app (removed as it is read), or null. */
  consumePendingFallback(): (LiveCallFallback & { at: number }) | null;
}

export const LiveCall = requireOptionalNativeModule<LiveCallNative>("LiveCall");
