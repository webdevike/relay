// Seams between transport, input and storage. Mirrors apps/mac/Sources/RelayCore/Seams.swift:
// the session only ever talks to these; input/ and the stores implement them; main.ts wires them.

import type { AckError, AgentImage, AgentMessage, AgentOptions, AgentSession, Command, InputEvent, KeyName, ServerMessage } from "@relay/protocol";

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

/** Where a paired phone's push token lives; the session writes it on `push.register` / `push.unregister`. */
export interface PushRegistry {
  register(deviceId: string, token: string): void;
  unregister(deviceId: string): void;
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
  /**
   * Deliver `text` (and any `images`) as the next user turn, or only `text` into the session's
   * input. The session enforces the protocol's rule that images require `submit`. Rejects with `AckFailure`.
   */
  reply(sessionId: string, text: string, submit: boolean, images?: readonly AgentImage[]): Promise<void>;
  /** Open a new session on the host. Rejects with `AckFailure` (`agent_launch_failed`). */
  launch(): Promise<void>;
  /** Models and skills the session offers; null when the session is unknown. */
  options(sessionId: string): Promise<AgentOptions | null>;
  /** Bytes behind an `AgentImageRef`; null when the session or the image is unknown. */
  image(sessionId: string, id: string): Promise<AgentImage | null>;
  /** Apply the given settings. Rejects with `AckFailure` (`agent_not_found`, `agent_configure_failed`). */
  configure(change: AgentConfigChange): Promise<void>;
  /** Interrupt the session's current turn. Rejects with `AckFailure` (`agent_not_found`). */
  abort(sessionId: string): Promise<void>;
  /** Shut the session down (omp exits). Rejects with `AckFailure` (`agent_not_found`). */
  end(sessionId: string): Promise<void>;
  /** Set by the transport. */
  onChange: ((change: AgentProviderChange) => void) | null;
}

export type AgentConfigChange = Omit<Extract<Command, { kind: "agent.configure" }>, "kind">;

