// Seams between transport, input and storage. Mirrors apps/mac/Sources/RelayCore/Seams.swift:
// the session only ever talks to these; input/ and the stores implement them; main.ts wires them.

import type { AckError, AgentMessage, AgentSession, InputEvent, KeyName, ServerMessage } from "@relay/protocol";

/** Outbound side of one connection. `send` after `close` is a no-op. */
export interface FrameSink {
  send(message: ServerMessage): void;
  close(): void;
}

/** Consumes ephemeral trackpad input. Must be cheap and never block; drop rather than queue. */
export interface InputSink {
  handle(events: readonly InputEvent[]): void;
}

/** Types into whatever has keyboard focus. Rejects / throws `AckFailure`. */
export interface TextInjecting {
  insert(text: string): Promise<void>;
  press(key: KeyName): Promise<void>;
}

/**
 * Linux stand-in for macOS Accessibility trust: whether the virtual input device could be
 * created (the user can open `/dev/uinput`). Drives `MacState.accessibilityGranted`.
 */
export interface InputAccess {
  readonly granted: boolean;
}

export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number; // unix epoch ms
}

export interface DeviceStore {
  secret(deviceId: string): Uint8Array | null;
  save(secret: Uint8Array, deviceId: string, deviceName: string): void;
  forget(deviceId: string): void;
  pairedDevices(): PairedDevice[];
}

/** Shows / hides the pairing PIN. Exactly one `endPairing` per `beginPairing`. */
export interface PairingUI {
  beginPairing(deviceName: string, pin: string): void;
  endPairing(): void;
}

/** A command failure the phone should see as a `nack`. */
export class AckFailure extends Error {
  readonly error: AckError;

  constructor(error: AckError) {
    super(error.message);
    this.error = error;
  }
}

export type AgentProviderChange =
  /** The session list (or any session's status/activity) changed; read `sessions` again. */
  | { readonly kind: "sessions" }
  /** New messages were appended to a conversation the transport may be subscribed to. */
  | { readonly kind: "conversation"; readonly sessionId: string; readonly appended: readonly AgentMessage[] };

/**
 * One coding-agent integration (omp on Linux). Provider-independent by construction: the
 * transport never sees anything but `AgentSession` / `AgentMessage`.
 */
export interface AgentProvider {
  /** Stable id used as `AgentSession.provider`. */
  readonly id: string;
  /** Whether the provider is installed and observing (drives `MacState.agentsAvailable`). */
  readonly isAvailable: boolean;
  /** Begin observing. Idempotent. */
  start(): void;
  /** Current sessions, newest activity first. Cheap: a cached array. */
  readonly sessions: readonly AgentSession[];
  /** Full conversation, oldest first; null when the session is unknown. */
  conversation(sessionId: string): Promise<AgentMessage[] | null>;
  /** Deliver `text` as the next user turn, or only into the session's input. Rejects with `AckFailure`. */
  reply(sessionId: string, text: string, submit: boolean): Promise<void>;
  /** Set by the transport. */
  onChange: ((change: AgentProviderChange) => void) | null;
}

