/**
 * Relay wire protocol, v1.
 *
 * One WebSocket per phone<->Mac connection. Every frame is a UTF-8 JSON text frame with a `t`
 * discriminator. The Mac is authoritative for all stateful data; the phone keeps a cache so the
 * UI is immediate, then overwrites it with the Mac's snapshot on every (re)connect.
 *
 * Three traffic classes, never mixed:
 *  - handshake   hello / challenge / auth / pair.* / welcome. Ordered, one in flight.
 *  - ephemeral   `input` batches. Fire-and-forget. Dropped when not connected, never queued.
 *  - reliable    `cmd` with a client-generated id, answered by exactly one `ack`. The phone
 *                retries un-acked cmds on reconnect; the Mac dedups by id.
 *  - state       Mac -> phone snapshots and deltas with a monotonically increasing `rev` per
 *                topic. A gap (`rev !== known + 1`) means the phone re-requests the snapshot.
 *
 * The Swift mirror lives in apps/mac/Sources/RelayProtocol and is conformance-tested against
 * packages/protocol/fixtures. Change both or neither.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const BONJOUR_SERVICE_TYPE = "_relay._tcp" as const;
export const WS_PATH = "/relay" as const;

// ---------------------------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------------------------

const ms = z.number().finite();
const nonEmpty = z.string().min(1);

export const AgentStatus = z.enum(["working", "waiting", "needs_permission", "idle", "ended"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** Provider-independent view of one coding-agent session. */
export const AgentSession = z.object({
  id: nonEmpty,
  provider: nonEmpty, // "claude-code" in v1; open string so new providers need no schema change
  title: nonEmpty, // usually the project directory name
  projectPath: nonEmpty,
  status: AgentStatus,
  /** Optional short human string for status (e.g. the tool awaiting permission). */
  statusDetail: z.string().optional(),
  /** One line describing the most recent thing that happened. */
  lastActivity: z.string(),
  lastActivityAt: ms, // unix epoch ms
  /** Whether the Mac knows how to deliver a reply into this session. */
  canRespond: z.boolean(),
  /** Display name of the model the session is currently using, when the provider reports it. */
  model: z.string().optional(),
  /** Company behind `model` (e.g. "anthropic"), when the provider reports it. */
  modelVendor: z.string().optional(),
  /** Current thinking level selector (e.g. "off", "low", "high"), when the provider reports it. */
  thinkingLevel: z.string().optional(),
  /** Share of the model's context window in use, 0..1, when the provider reports it. */
  contextUsed: z.number().min(0).max(1).optional(),
});
export type AgentSession = z.infer<typeof AgentSession>;

/**
 * A model the session could switch to, with the thinking levels it accepts. The host lists
 * these grouped by vendor, newest revision first within each vendor.
 */
export const AgentModel = z.object({
  provider: nonEmpty,
  id: nonEmpty,
  name: nonEmpty,
  /** Company behind the model (e.g. "anthropic"), which may differ from the hosting provider. */
  vendor: nonEmpty,
  thinkingLevels: z.array(nonEmpty),
});
export type AgentModel = z.infer<typeof AgentModel>;

/**
 * Something the session can be pointed at from the wheel: an authored skill or a slash command.
 * `command` is exactly what the host puts before the dictation: the slash token, plus the
 * subcommand word when the text belongs to one (`/goal set`). `takesText` false means the command
 * is complete on its own and is sent as soon as it is picked.
 */
export const AgentSkillChoice = z.object({
  name: nonEmpty,
  description: z.string(),
  command: nonEmpty.regex(/^\/\S+( \S+)*$/),
  takesText: z.boolean(),
});
export type AgentSkillChoice = z.infer<typeof AgentSkillChoice>;

/** A wheel entry; with `choices`, it opens a second ring of subcommands (`/goal` → set, show, pause...). */
export const AgentSkill = AgentSkillChoice.extend({
  choices: z.array(AgentSkillChoice).optional(),
});
export type AgentSkill = z.infer<typeof AgentSkill>;

/** What a session can be switched to or pointed at; answered per `agent.options` request. */
export const AgentOptions = z.object({
  models: z.array(AgentModel),
  skills: z.array(AgentSkill),
});
export type AgentOptions = z.infer<typeof AgentOptions>;

/** Largest image payload (base64 length) one frame carries; a phone screenshot as JPEG is well under. */
export const MAX_IMAGE_BASE64 = 6 * 1024 * 1024;
export const MAX_REPLY_IMAGES = 4;

/** Image bytes crossing the wire: base64. WebP is what omp re-encodes attachments to. */
export const AgentImage = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z.string().min(1).max(MAX_IMAGE_BASE64),
});
export type AgentImage = z.infer<typeof AgentImage>;

// ---------------------------------------------------------------------------------------------
// Drops: a shared drop box between the phone and the host. The host owns the history (newest
// first, bounded); either side adds to it explicitly. Text and links ride the socket; image and
// file bytes are fetched over HTTP from the host at `Drop.file.path` on the relay port.
// ---------------------------------------------------------------------------------------------

export const MAX_DROPS = 100;
/** Longest text drop, in UTF-16 code units; anything bigger goes as a file. */
export const MAX_DROP_TEXT = 64 * 1024;
/** Largest blob the host keeps per drop, in bytes. */
export const MAX_DROP_BYTES = 50 * 1024 * 1024;

export const DropKind = z.enum(["text", "link", "image", "file"]);
export type DropKind = z.infer<typeof DropKind>;

export const DropOrigin = z.enum(["host", "phone"]);
export type DropOrigin = z.infer<typeof DropOrigin>;

export const DropFile = z.object({
  name: nonEmpty,
  mimeType: nonEmpty,
  /** Bytes on disk. */
  size: z.number().int().nonnegative(),
  /**
   * Path on the relay HTTP port, `/drops/<id>/<token>`; the token is unguessable and is the only
   * credential the fetch needs. Prefix it with `http://<host>:<port>` of the live connection.
   */
  path: nonEmpty,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type DropFile = z.infer<typeof DropFile>;

export const Drop = z.object({
  id: nonEmpty,
  kind: DropKind,
  origin: DropOrigin,
  createdAt: ms, // unix epoch ms
  /** One-line preview: the first line of text, the URL, or the file name. */
  title: nonEmpty,
  /** Full content for `text` and `link`; absent for `image` and `file`. */
  text: z.string().max(MAX_DROP_TEXT).optional(),
  /** Present for `image` and `file`; absent for `text` and `link`. */
  file: DropFile.optional(),
});
export type Drop = z.infer<typeof Drop>;

/**
 * An image attached to a transcript message. Only a reference travels with the transcript; the
 * bytes are fetched once per `id` with `agent.image` so a re-sent conversation stays small.
 */
export const AgentImageRef = z.object({
  id: nonEmpty,
  mimeType: AgentImage.shape.mimeType,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type AgentImageRef = z.infer<typeof AgentImageRef>;

export const AgentMessageRole = z.enum(["user", "assistant", "tool", "system"]);
export type AgentMessageRole = z.infer<typeof AgentMessageRole>;

export const AgentMessage = z.object({
  id: nonEmpty,
  role: AgentMessageRole,
  text: z.string(),
  at: ms,
  /** Present when role === "tool": the tool that ran and a one-line summary of its input. */
  tool: z.object({ name: nonEmpty, summary: z.string() }).optional(),
  /** Images the message carried (a pasted screenshot, a tool's rendered page). */
  images: z.array(AgentImageRef).optional(),
});
export type AgentMessage = z.infer<typeof AgentMessage>;

export const MacState = z.object({
  name: nonEmpty,
  version: nonEmpty,
  /** AXIsProcessTrusted(). False means pointer/keyboard commands will be refused. */
  accessibilityGranted: z.boolean(),
  /** At least one agent provider is installed and observing. */
  agentsAvailable: z.boolean(),
});
export type MacState = z.infer<typeof MacState>;

export const AgentsSnapshot = z.object({
  rev: z.number().int().nonnegative(),
  sessions: z.array(AgentSession),
});
export type AgentsSnapshot = z.infer<typeof AgentsSnapshot>;

export const Snapshot = z.object({
  mac: MacState,
  agents: AgentsSnapshot,
});
export type Snapshot = z.infer<typeof Snapshot>;

// ---------------------------------------------------------------------------------------------
// Ephemeral input events (phone -> Mac). Units: phone points; t: phone monotonic ms.
// ---------------------------------------------------------------------------------------------

export const ScrollPhase = z.enum(["began", "changed", "ended", "momentum", "momentumEnded"]);
export type ScrollPhase = z.infer<typeof ScrollPhase>;

export const InputEvent = z.discriminatedUnion("k", [
  z.object({ k: z.literal("move"), dx: z.number(), dy: z.number(), t: ms }),
  z.object({ k: z.literal("click"), button: z.enum(["left", "right"]), t: ms }),
  /** Drag = left button held while `move` events flow. `start` presses, `end` releases. */
  z.object({ k: z.literal("drag"), phase: z.enum(["start", "end"]), t: ms }),
  z.object({ k: z.literal("scroll"), dx: z.number(), dy: z.number(), phase: ScrollPhase, t: ms }),
]);
export type InputEvent = z.infer<typeof InputEvent>;

// ---------------------------------------------------------------------------------------------
// Reliable commands (phone -> Mac), acked exactly once.
// ---------------------------------------------------------------------------------------------

export const KeyName = z.enum(["return", "escape", "backspace", "tab"]);
export type KeyName = z.infer<typeof KeyName>;

export const Command = z.discriminatedUnion("kind", [
  /** Type `text` into whatever has keyboard focus on the Mac. */
  z.object({ kind: z.literal("text.insert"), text: z.string().min(1) }),
  z.object({ kind: z.literal("key.press"), key: KeyName }),
  /**
   * Put `image` on the host clipboard and paste it into whatever has keyboard focus (Ctrl+V on
   * Linux, Cmd+V on the Mac). Text from the phone's clipboard goes through `text.insert` instead.
   */
  z.object({ kind: z.literal("clipboard.paste"), image: AgentImage }),
  /**
   * Hand `text` (and any `images`) to an agent session. `submit: true` sends it as the next user
   * turn; `false` only places the text in the session's input so the user can finish it at the
   * keyboard (images cannot be parked there, so they require `submit`). Text may be empty only
   * when images are present.
   */
  z.object({
    kind: z.literal("agent.reply"),
    sessionId: nonEmpty,
    text: z.string(),
    submit: z.boolean(),
    images: z.array(AgentImage).min(1).max(MAX_REPLY_IMAGES).optional(),
  }),
  /** Open a fresh agent session on the host (it shows up in `agents.*` once it registers). */
  z.object({ kind: z.literal("agent.start") }),
  /** Change one or more session settings; omitted fields are left alone. */
  z.object({
    kind: z.literal("agent.configure"),
    sessionId: nonEmpty,
    title: nonEmpty.optional(),
    model: z.object({ provider: nonEmpty, id: nonEmpty }).optional(),
    thinkingLevel: nonEmpty.optional(),
  }),
  /** Interrupt whatever the session is doing right now. */
  z.object({ kind: z.literal("agent.abort"), sessionId: nonEmpty }),
  /** Shut the session down: omp exits and the terminal it ran in closes. */
  z.object({ kind: z.literal("agent.end"), sessionId: nonEmpty }),
  /**
   * Add a drop from the phone. Exactly one of `text` or `image`; the host classifies text that
   * is a single URL as a `link`.
   */
  z.object({
    kind: z.literal("drop.put"),
    text: z.string().min(1).max(MAX_DROP_TEXT).optional(),
    image: AgentImage.optional(),
  }),
  z.object({ kind: z.literal("drop.delete"), id: nonEmpty }),
]);
export type Command = z.infer<typeof Command>;

export const AckError = z.object({
  code: z.enum([
    "accessibility_denied",
    "agent_not_found",
    "agent_cannot_respond",
    "agent_launch_failed",
    "agent_configure_failed",
    "invalid_command",
    "internal",
    "drop_unavailable",
    "drop_not_found",
  ]),
  message: z.string(),
});
export type AckError = z.infer<typeof AckError>;

// ---------------------------------------------------------------------------------------------
// Phone -> Mac frames
// ---------------------------------------------------------------------------------------------

export const ClientHello = z.object({
  t: z.literal("hello"),
  v: z.literal(PROTOCOL_VERSION),
  deviceId: nonEmpty,
  deviceName: nonEmpty,
  platform: z.literal("ios"),
});

export const ClientMessage = z.discriminatedUnion("t", [
  ClientHello,
  /** proof = hex(HMAC-SHA256(secret, nonce)) */
  z.object({ t: z.literal("auth"), proof: nonEmpty }),
  z.object({ t: z.literal("pair.request") }),
  z.object({ t: z.literal("pair.confirm"), pin: z.string().regex(/^\d{6}$/) }),
  z.object({ t: z.literal("input"), events: z.array(InputEvent).min(1).max(256) }),
  z.object({ t: z.literal("cmd"), id: nonEmpty, cmd: Command }),
  z.object({ t: z.literal("ping"), ts: ms }),
  z.object({ t: z.literal("agents.get") }),
  z.object({ t: z.literal("agent.subscribe"), sessionId: nonEmpty }),
  z.object({ t: z.literal("agent.unsubscribe"), sessionId: nonEmpty }),
  /** Ask which models/thinking levels/skills a session offers; answered by `agent.options`. */
  z.object({ t: z.literal("agent.options"), sessionId: nonEmpty }),
  /** Fetch the bytes behind an `AgentImageRef`; answered by `agent.image`. */
  z.object({ t: z.literal("agent.image"), sessionId: nonEmpty, id: nonEmpty }),
  /**
   * Have the host push a notification to this device when a session starts waiting on the user.
   * `token` is an Expo push token; the host keeps it per paired device until `push.unregister`.
   */
  z.object({ t: z.literal("push.register"), token: nonEmpty }),
  z.object({ t: z.literal("push.unregister") }),
  /** Ask for the drop history; answered by `drop.list`. */
  z.object({ t: z.literal("drop.list") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------------------------
// Mac -> phone frames
// ---------------------------------------------------------------------------------------------

export const ErrorCode = z.enum([
  "version_mismatch",
  "unknown_device", // secret no longer on the Mac; phone must forget it and re-pair
  "auth_failed",
  "protocol", // malformed frame or wrong phase
  "busy", // another pairing is in progress
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const PairFailure = z.enum(["wrong_pin", "rejected", "timeout", "too_many_attempts"]);
export type PairFailure = z.infer<typeof PairFailure>;

export const ServerMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("challenge"), nonce: nonEmpty }),
  /** Device not paired. Phone shows the pairing UI and sends pair.request. */
  z.object({ t: z.literal("unpaired") }),
  /** Mac is showing the PIN; phone shows the PIN entry. */
  z.object({ t: z.literal("pair.pending") }),
  /** Paired. `secret` is hex; the phone stores it and never sends it again. */
  z.object({ t: z.literal("pair.ok"), secret: nonEmpty }),
  z.object({ t: z.literal("pair.failed"), reason: PairFailure }),
  z.object({ t: z.literal("welcome"), state: Snapshot }),
  z.object({ t: z.literal("error"), code: ErrorCode, message: z.string() }),
  z.object({ t: z.literal("mac.state"), mac: MacState }),
  z.object({ t: z.literal("agents.snapshot"), rev: z.number().int(), sessions: z.array(AgentSession) }),
  z.object({
    t: z.literal("agents.delta"),
    rev: z.number().int(),
    upsert: z.array(AgentSession).optional(),
    remove: z.array(nonEmpty).optional(),
  }),
  z.object({
    t: z.literal("agent.conversation"),
    sessionId: nonEmpty,
    rev: z.number().int(),
    messages: z.array(AgentMessage),
  }),
  z.object({
    t: z.literal("agent.messages"),
    sessionId: nonEmpty,
    rev: z.number().int(),
    append: z.array(AgentMessage),
  }),
  z.object({ t: z.literal("agent.options"), sessionId: nonEmpty, models: z.array(AgentModel), skills: z.array(AgentSkill) }),
  /** `image` is null when the session no longer has that image. */
  z.object({ t: z.literal("agent.image"), sessionId: nonEmpty, id: nonEmpty, image: AgentImage.nullable() }),
  /** A drop was added on either side; also mirrored as a push notification for host-origin drops. */
  z.object({ t: z.literal("drop.new"), drop: Drop }),
  z.object({ t: z.literal("drop.removed"), id: nonEmpty }),
  /** Answer to `drop.list`: the whole history, newest first. */
  z.object({ t: z.literal("drop.list"), drops: z.array(Drop).max(MAX_DROPS) }),
  z.object({ t: z.literal("ack"), id: nonEmpty }),
  z.object({ t: z.literal("nack"), id: nonEmpty, error: AckError }),
  z.object({ t: z.literal("pong"), ts: ms, serverTs: ms }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---------------------------------------------------------------------------------------------
// Codec helpers
// ---------------------------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseWith(ServerMessage, raw);
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseWith(ClientMessage, raw);
}

function parseWith<S extends z.ZodTypeAny>(schema: S, raw: string): ParseResult<z.infer<S>> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, value: result.data as z.infer<S> };
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export * from "./hmac";
