// Seams between transport, input and storage. Mirrors apps/mac/Sources/RelayCore/Seams.swift:
// the session only ever talks to these; input/ and the stores implement them; main.ts wires them.

import type { AckError, AgentApproval, AgentAsk, AgentAskAnswer, AgentImage, AgentMessage, AgentOptions, AgentSession, ApprovalConfirmation, AssistantAgent, AssistantSnapshot, ClientMessage, Command, Drop, DropOrigin, GateStatus, InboxItem, InboxResolve, InputEvent, KeyName, ServerMessage } from "@relay/protocol";

/** Outbound side of one connection. `send` after `close` is a no-op. */
export interface FrameSink {
  send(message: ServerMessage): void;
  close(): void;
}

/** The live view's VNC bridge (`VNC_PATH`), as the session sees it. */
export interface VncAccess {
  /**
   * A one-time ticket that lets `deviceId` open the bridge, or null when nothing listens on the
   * Mac's VNC port (Screen Sharing is off).
   */
  open(deviceId: string): Promise<string | null>;
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

/**
 * What the session needs of the phone-escalation inbox (`inbox/service.ts`): frames the escalator
 * sends, the items a device that just connected missed, and the claim a phone's answer makes so
 * the Mac's row can say who answered.
 */
export interface InboxRelaying {
  item(deviceId: string, item: InboxItem): void;
  resolve(deviceId: string, resolve: Pick<InboxResolve, "id" | "answer">): void;
  pending(): readonly InboxItem[];
  /** `deviceId` is about to answer `id` (`approval:<approval id>` or `ask:<ask id>`) with `answer`. */
  claim(id: string, deviceId: string, answer: string): void;
  /** The claimed answer failed; forget it. */
  release(id: string): void;
  /** omp reported the approval or ask closed, whoever answered. */
  settled(kind: "approval" | "ask", requestId: string): void;
}

/**
 * One of the host's long-lived assistant threads (`assistant/service.ts`), named by its registry
 * entry: the thread as a snapshot, a turn from a phone or from the host's own jobs, and a sign-in.
 */
export interface AssistantThread {
  /** Registry id, e.g. "astra". */
  readonly id: string;
  /** Registry title, e.g. "Astra". */
  readonly title: string;
  /** The thread as it stands; empty and idle while the agent is not running. */
  snapshot(): Promise<AssistantSnapshot>;
  /** This agent's row in `assistant.agents`: its registry entry, where its session stands and its newest reply. */
  listing(): Promise<AssistantAgent>;
  /** Delivers `text` and any `images` as Isaac's next turn, starting or resuming the agent first. Rejects with `AckFailure` (`agent_launch_failed`). */
  turn(text: string, images?: readonly AgentImage[]): Promise<void>;
  /** A background job's message to the agent, delivered as a turn it then tells Isaac about. Rejects like `turn`. */
  say(text: string): Promise<void>;
  /** Types Isaac's credentials into the login page `url` the agent asked him to sign in to (message `messageId`). Rejects with `AckFailure`. */
  signin(messageId: string, url: string, username: string, password: string): Promise<void>;
}

/** What the session and server need of the host's assistant threads: every registry agent's thread. */
export interface AssistantRelaying {
  /** Registry order; the first is the default. */
  readonly threads: readonly AssistantThread[];
  /** Thread `id`, or the default when `id` is undefined (requests from older phones); undefined for an unknown id. */
  thread(id: string | undefined): AssistantThread | undefined;
  /** Every thread's listing in registry order, as `assistant.agents` carries it. */
  agents(): Promise<AssistantAgent[]>;
  /** Every provider change; each thread picks out its own session's. */
  observe(change: AgentProviderChange): void;
}

/** What the session needs of the host's live canvas rooms (`canvas/service.ts`). */
export interface CanvasRelaying {
  /** `canvas.rooms`: every room the host holds, at its current rev. */
  snapshot(): Extract<ServerMessage, { t: "canvas.rooms" }>;
  /** `canvas.open` from `deviceId`: a token for the live room on `slug`, or why there is none. */
  open(slug: string, deviceId: string): Extract<ServerMessage, { t: "canvas.access" | "canvas.unavailable" }>;
}

/** The phone's `call.*` frames. */
export type CallClientMessage = Extract<ClientMessage, { t: `call.${string}` }>;

/** What the session and server need of the host's voice calls (`call/service.ts`): one call per socket, named by its sink. */
export interface CallRelaying {
  /** A `call.*` frame from the phone on `sink`; replies go back through it. */
  receive(sink: FrameSink, message: CallClientMessage): void;
  /** The socket closed: hang up its call. */
  drop(sink: FrameSink): void;
  /** Every provider change; each call picks out its agent's session. */
  observe(change: AgentProviderChange): void;
  /** A phone opened an assistant's thread: a call may follow, so load the speech models now. */
  warm(): void;
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
  /** `bytes` larger than `MAX_DROP_BYTES` throw, `video/*` ones larger than the video cap throw `VideoTooLarge`. Images (by `mimeType`) become `image` drops. */
  putBlob(origin: DropOrigin, blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }): Drop;
  /** A `video/*` blob (kind `file`) with its duration, display size and poster filled in where the host can read them. */
  putVideo(origin: DropOrigin, blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }): Promise<Drop>;
  /** False when no such drop. */
  remove(id: string): boolean;
  /** The blob for `id` iff `token` matches its `DropFile.path`; null otherwise (also for text drops). */
  open(id: string, token: string): DropBlob | null;
  /** A video drop's poster JPEG under the same token check; null when it has none. */
  openPoster(id: string, token: string): DropBlob | null;
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
  | { readonly kind: "ask.resolved"; readonly sessionId: string; readonly id: string }
  /** The session is now blocked on a tool approval; the transport shows it to subscribed phones. */
  | { readonly kind: "approval"; readonly sessionId: string; readonly approval: AgentApproval }
  /** A pending approval closed (approved, denied, or settled in the TUI); dismiss it. */
  | { readonly kind: "approval.resolved"; readonly sessionId: string; readonly id: string }
  /** The habit gate's state changed; read `gate` again. */
  | { readonly kind: "gate" };

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
  /**
   * Hand `text` to the session as a quiet note: in the model's context from its next turn on, never
   * shown and never a turn of its own. Resolves false when the session's bridge predates notes;
   * rejects with `AckFailure` (`agent_not_found`) for an unknown session.
   */
  note(sessionId: string, text: string): Promise<boolean>;
  /** Open a new session on the host. Rejects with `AckFailure` (`agent_launch_failed`). */
  launch(prompt?: string, thinkingLevel?: string, profile?: "personal" | "work"): Promise<void>;
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
  /**
   * Approve (`allow`) or deny the tool call the session is blocked on, so omp carries on. A
   * destructive call needs `confirmed`. Rejects with `AckFailure` (`agent_not_found`,
   * `agent_cannot_respond` when the approval is gone, `biometric_required`).
   */
  decideApproval(sessionId: string, approvalId: string, allow: boolean, confirmed?: ApprovalConfirmation): Promise<void>;
  /** The approval the session is currently blocked on, replayed to a phone that subscribes late; null when none. */
  pendingApproval(sessionId: string): AgentApproval | null;
  /** The habit gate as the omp bridge last reported it; null when no session reports one. */
  readonly gate: GateStatus | null;
  /**
   * Run a phone's gate command through the gate CLI. Rejects with `AckFailure` (`gate_unavailable`
   * when no session reports a gate, `gate_failed` with the CLI's message otherwise).
   */
  runGate(cmd: GateCommand): Promise<void>;
  /** Set by the transport. */
  onChange: ((change: AgentProviderChange) => void) | null;
}

export type AgentConfigChange = Omit<Extract<Command, { kind: "agent.configure" }>, "kind">;

export type GateCommand = Extract<Command, { kind: "gate.start" | "gate.done" | "gate.override" }>;

