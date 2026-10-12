// Seams between transport, input and storage. Mirrors apps/mac/Sources/RelayCore/Seams.swift:
// the session only ever talks to these; input/ and the stores implement them; main.ts wires them.

import type { AckError, AgentAsk, AgentAskAnswer, AgentImage, AgentMessage, AgentOptions, AgentSession, Command, Drop, DropOrigin, InputEvent, KeyName, ScreenError, ScreenKey, ScreenWindow, ServerMessage } from "@relay/protocol";

/** Outbound side of one connection. `send` after `close` is a no-op. */
export interface FrameSink {
  send(message: ServerMessage): void;
  close(): void;
  /** Bytes queued on the socket and not yet written; live-view frames are skipped while it is high. */
  readonly buffered: number;
}

/** One captured frame: JPEG bytes and their pixel size. */
export interface ScreenFrame {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Phone input for the watched window; points are normalized 0..1 over the window. */
export type ScreenInput =
  | { readonly t: "tap"; readonly x: number; readonly y: number }
  | { readonly t: "scroll"; readonly dx: number; readonly dy: number; readonly x?: number; readonly y?: number }
  | { readonly t: "text"; readonly text: string }
  | { readonly t: "key"; readonly key: ScreenKey }
  /** Relative cursor move in host points; scroll without x/y acts at the cursor. */
  | { readonly t: "move"; readonly dx: number; readonly dy: number }
  | { readonly t: "click"; readonly button: "left" | "right" }
  /** Smaller, lower-quality frames while the phone drives the trackpad. */
  | { readonly t: "lite"; readonly on: boolean };

/** A running capture; `stop` ends it without an `onEnd` call. */
export interface ScreenWatch {
  stop(): void;
  /** Clicks, scrolls or types into the watched window; dropped once stopped. */
  input(event: ScreenInput): void;
}

/** Window capture for the live view (ScreenCaptureKit through the `relay-screen` helper on macOS). */
export interface ScreenCapture {
  list(): Promise<{ windows: ScreenWindow[]; error?: ScreenError }>;
  /**
   * Frames flow to `onFrame` and cursor positions (normalized over the window, outside 0..1 when
   * off it) to `onCursor` until `stop`, or until capture ends on its own, reported once via `onEnd`.
   */
  watch(
    windowId: number,
    onFrame: (frame: ScreenFrame) => void,
    onCursor: (x: number, y: number) => void,
    onEnd: (error: ScreenError) => void,
  ): ScreenWatch;
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

/** Puts an image on the system clipboard and pastes it into the focused app. Rejects with `AckFailure`. */
export interface ImagePasting {
  paste(image: AgentImage): Promise<void>;
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

export type DropChange = { readonly kind: "added"; readonly drop: Drop } | { readonly kind: "removed"; readonly id: string };

/** Bytes behind an `image` or `file` drop, resolved for an HTTP response. */
export interface DropBlob {
  readonly path: string;
  readonly mimeType: string;
  readonly name: string;
  readonly size: number;
}

/**
 * The shared drop box: history newest first, bounded to `MAX_DROPS`. Every mutation, from any
 * caller (phone command, CLI, HTTP), reports through `onChange` so the server can fan it out.
 */
export interface DropBox {
  onChange: ((change: DropChange) => void) | null;
  list(): readonly Drop[];
  /** Text becomes a `link` drop when it is a single URL. */
  putText(origin: DropOrigin, text: string): Drop;
  /** `bytes` larger than `MAX_DROP_BYTES` throw. Images (by `mimeType`) become `image` drops. */
  putBlob(origin: DropOrigin, blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }): Drop;
  /** False when no such drop. */
  remove(id: string): boolean;
  /** The blob for `id` iff `token` matches its `DropFile.path`; null otherwise (also for text drops). */
  open(id: string, token: string): DropBlob | null;
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
  | { readonly kind: "conversation"; readonly sessionId: string; readonly appended: readonly AgentMessage[] }
  /** A streaming message's text so far (full text, idempotent); `streaming: false` is the settled text. */
  | { readonly kind: "message"; readonly sessionId: string; readonly id: string; readonly text: string; readonly streaming: boolean }
  /** The session is now blocked on an ask; the transport shows it to subscribed phones. */
  | { readonly kind: "ask"; readonly sessionId: string; readonly ask: AgentAsk }
  /** A pending ask closed (answered in the TUI, cancelled, or answered from a phone); dismiss its card. */
  | { readonly kind: "ask.resolved"; readonly sessionId: string; readonly id: string };

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
  launch(prompt?: string, thinkingLevel?: string): Promise<void>;
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
  /** Deliver a phone's answer to a pending ask. Rejects with `AckFailure` (`agent_cannot_respond`). */
  answerAsk(sessionId: string, askId: string, results: readonly AgentAskAnswer[]): Promise<void>;
  /** Dismiss a pending ask without an answer; omp's dialog resolves as cancelled. Rejects with `AckFailure`. */
  cancelAsk(sessionId: string, askId: string): Promise<void>;
  /** The ask the session is currently blocked on, replayed to a phone that subscribes late; null when none. */
  pendingAsk(sessionId: string): AgentAsk | null;
  /** Set by the transport. */
  onChange: ((change: AgentProviderChange) => void) | null;
}

export type AgentConfigChange = Omit<Extract<Command, { kind: "agent.configure" }>, "kind">;

