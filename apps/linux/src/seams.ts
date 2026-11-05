// Seams between transport, input and storage. Mirrors apps/mac/Sources/RelayCore/Seams.swift:
// the session only ever talks to these; input/ and the stores implement them; main.ts wires them.

import type {
  AckError,
  AgentApproval,
  AgentAsk,
  AgentAskAnswer,
  AgentImage,
  AgentMessage,
  AgentOptions,
  AgentSession,
  ApprovalConfirmation,
  AssistantAgent,
  AssistantFileReq,
  AssistantFileRes,
  AssistantSnapshot,
  ClientMessage,
  Command,
  ControlPresence,
  ControlResult,
  Drop,
  DropOrigin,
  FileFocus,
  GateStatus,
  InboxItem,
  InboxResolve,
  InputEvent,
  KeyName,
  MeetingsOp,
  MeetingsResult,
  MeetingsState,
  ReviewsOp,
  ReviewsResult,
  ServerMessage,
  StudioOp,
  StudioResult,
  StudioState,
} from "@relay/protocol";

/** Outbound side of one connection. `send` after `close` is a no-op. */
export interface FrameSink {
  send(message: ServerMessage): void;
  close(): void;
}

/** A device's socket as live file presence knows it: replies and pushes go through `sink`. */
export interface FileClient {
  readonly sink: FrameSink;
  readonly device: string;
  readonly deviceName: string;
}

/** What the session needs of live file presence (`files/presence.ts`): one entry per socket, named by its sink. */
export interface FilePresenceRelaying {
  /** `files.open`: the files this socket's editor has open now. */
  open(client: FileClient, paths: readonly string[]): void;
  /** `files.caret`: where Isaac's caret is on this socket's device, or nowhere. */
  caret(client: FileClient, focus: FileFocus | null): void;
  /** `files.saved`: Isaac's editor is writing `path` with bytes of this sha1. */
  saved(path: string, hash: string): void;
  /** The socket closed: forget its files and its caret. */
  drop(sink: FrameSink): void;
}

/** A desktop's socket as remote control knows it. */
export interface ControlClient {
  readonly sink: FrameSink;
  readonly device: string;
  /** The socket comes from this Mac (loopback). */
  readonly loopback: boolean;
}

/** What the session needs of remote control (`control/relay.ts`): one desktop per socket, named by its sink. */
export interface ControlRelaying {
  /** `control.presence`: this socket's desktop can be driven; how long since Isaac used it. */
  presence(client: ControlClient, presence: ControlPresence): void;
  /** `control.res`: the answer to a `control.req` this socket was sent. */
  result(sink: FrameSink, rid: string, result: ControlResult): void;
  /** The socket closed: forget its desktop and fail what it still owed. */
  drop(sink: FrameSink): void;
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
  /** Asks the OS for the permission (macOS: its Accessibility prompt). Called when input is refused. */
  request?(): void;
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
  /** The assistants `deviceId` wants no pushes from (`push.prefs`); replaces the list. */
  setMuted(deviceId: string, muted: readonly string[]): void;
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
  /**
   * `assistant.create`: adds an assistant to the registry (its prime runs the setup interview) and,
   * with `start`, starts its thread. Rejects with `AckFailure`. Absent where the host cannot write the registry.
   */
  create?(
    input: { readonly id?: string; readonly title: string; readonly scope?: string },
    start: boolean,
  ): Promise<{ readonly id: string; readonly title: string }>;
  /**
   * `assistant.file.req`: reads or saves agent `agent`'s prime.md or thread memory (`assistant/files.ts`).
   * Absent where the host has no agent home.
   */
  file?(
    req: Pick<AssistantFileReq, "agent" | "file" | "op" | "text" | "expectedHash" | "force">,
  ): Omit<AssistantFileRes, "t" | "rid">;
}

/** What the session needs of the host's live canvas rooms (`canvas/service.ts`). */
export interface CanvasRelaying {
  /** `canvas.rooms`: every room the host holds, at its current rev. */
  snapshot(): Extract<ServerMessage, { t: "canvas.rooms" }>;
  /** `canvas.open` from `deviceId`: a token for the live room on `slug`, or why there is none. */
  open(
    slug: string,
    deviceId: string,
  ): Extract<ServerMessage, { t: "canvas.access" | "canvas.unavailable" }>;
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

/** The phone's `live.*` frames. */
export type LiveClientMessage = Extract<ClientMessage, { t: `live.${string}` }>;

/** What the session and server need of the host's GPT-Live calls (`live/service.ts`): one call per socket, named by its sink. */
export interface LiveRelaying {
  /** A `live.*` frame from the phone on `sink`; replies go back through it. */
  receive(sink: FrameSink, message: LiveClientMessage): void;
  /** The socket closed; its call keeps running without it. */
  drop(sink: FrameSink): void;
  /** Every provider change; each call picks out its agent's session. */
  observe(change: AgentProviderChange): void;
}

export type DropChange =
  | { readonly kind: "added"; readonly drop: Drop }
  | { readonly kind: "removed"; readonly id: string };

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
  putBlob(
    origin: DropOrigin,
    blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array },
  ): Drop;
  /** A `video/*` blob (kind `file`) with its duration, display size and poster filled in where the host can read them. */
  putVideo(
    origin: DropOrigin,
    blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array },
  ): Promise<Drop>;
  /** An `audio/*` blob (kind `file`) with its duration filled in where the host can read it; an mp4/m4a is made streamable. */
  putAudio(
    origin: DropOrigin,
    blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array },
  ): Promise<Drop>;
  /** False when no such drop. */
  remove(id: string): boolean;
  /** The blob for `id` iff `token` matches its `DropFile.path`; null otherwise (also for text drops). */
  open(id: string, token: string): DropBlob | null;
  /** A video drop's poster JPEG under the same token check; null when it has none. */
  openPoster(id: string, token: string): DropBlob | null;
}

/**
 * What the session and server need of Studio (`studio/service.ts`): the state a `studio.list`
 * answers, one `studio.req` op at a time, and the asset files behind `/studio/<id>/<token>`.
 * Changes reach every device through the service's own broadcast.
 */
export interface StudioRelaying {
  state(): StudioState;
  /** Never rejects: a refusal is `{ ok: false, error }`. A `create` carries its own origin. */
  handle(op: StudioOp): Promise<Omit<StudioResult, "rid">>;
  /** An output's or upload's file iff `token` is its token; null otherwise. */
  open(id: string, token: string): DropBlob | null;
  /** Its JPEG preview (an image without one serves itself) under the same token check. */
  openThumb(id: string, token: string): DropBlob | null;
}

/**
 * What the session and server need of Reviews (`reviews/service.ts`): one `reviews.req` op at a
 * time, Linear's downloaded images behind `/reviews/media/<name>/<token>`, and every provider
 * change (an item's Astra session streaming or ending). `reviews.queue` and `reviews.astra` reach
 * every device through the service's own broadcast.
 */
export interface ReviewsRelaying {
  /** Never rejects: a failure is `{ ok: false, error }`. */
  handle(op: ReviewsOp): Promise<Omit<ReviewsResult, "rid">>;
  /** A downloaded image iff `token` is its token; null otherwise. */
  openMedia(name: string, token: string): DropBlob | null;
  observe(change: AgentProviderChange): void;
}

/** The text frames a recording's ingest socket carries out (`ack`, `meeting.done`, `meeting.stop`). */
export interface IngestPeer {
  sendText(frame: Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
}

/** One open ingest socket, as the server feeds it. */
export interface IngestConnection {
  text(raw: string): void;
  binary(data: Uint8Array): void;
  closed(): void;
}

/** What a redeemed ingest ticket lets its socket do: upload recording `id` from device `deviceId`. */
export interface IngestGrant {
  readonly id: string;
  readonly deviceId: string;
  readonly deviceName: string;
}

/**
 * What the session and server need of Meetings (`meetings/service.ts`): the state `meetings.list`
 * answers, one `meetings.req` op at a time, ingest tickets and their sockets, and every provider
 * change (Astra's session about a meeting). Changes reach every device through the service's own
 * broadcast.
 */
export interface MeetingsRelaying {
  state(): MeetingsState;
  /** Never rejects: a failure is `{ ok: false, error }`. */
  handle(op: MeetingsOp): Promise<Omit<MeetingsResult, "rid">>;
  /** A Mac's `meeting.ingest.open`: a one-time ticket for its socket, or why not. */
  openIngest(
    deviceId: string,
    deviceName: string,
    open: { id: string; app: string; title?: string | undefined; startedAt: number },
  ): { ticket: string } | { refused: string };
  /** Spends a ticket; null when unknown, spent or expired. */
  redeem(ticket: string): IngestGrant | null;
  connect(grant: IngestGrant, peer: IngestPeer): IngestConnection;
  observe(change: AgentProviderChange): void;
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
  | {
      readonly kind: "conversation";
      readonly sessionId: string;
      readonly appended: readonly AgentMessage[];
    }
  /** A streaming message's text so far (full text, idempotent); `streaming: false` is the settled text. */
  | {
      readonly kind: "message";
      readonly sessionId: string;
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
    }
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
  reply(
    sessionId: string,
    text: string,
    submit: boolean,
    images?: readonly AgentImage[],
  ): Promise<void>;
  /**
   * Hand `text` to the session as a quiet note: in the model's context from its next turn on, never
   * shown and never a turn of its own. Resolves false when the session's bridge predates notes;
   * rejects with `AckFailure` (`agent_not_found`) for an unknown session.
   */
  note(sessionId: string, text: string): Promise<boolean>;
  /**
   * Open a new session on the host, or reopen transcript file `resume`. Resolves once omp is
   * launched; `joined` then settles with the session id it registers under. Rejects with
   * `AckFailure` (`agent_launch_failed`).
   */
  launch(
    prompt?: string,
    thinkingLevel?: string,
    profile?: "personal" | "work",
    resume?: string,
  ): Promise<{ readonly joined: Promise<string> }>;
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
  decideApproval(
    sessionId: string,
    approvalId: string,
    allow: boolean,
    confirmed?: ApprovalConfirmation,
  ): Promise<void>;
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
