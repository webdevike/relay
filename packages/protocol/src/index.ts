/**
 * Relay wire protocol, v1.
 *
 * One WebSocket per phone<->Mac connection. Every frame is a UTF-8 JSON text frame with a `t`
 * discriminator. The Mac is authoritative for all stateful data; the phone keeps a cache so the
 * UI is immediate, then overwrites it with the Mac's snapshot on every (re)connect.
 *
 * Three traffic classes, never mixed:
 *  - handshake   hello / challenge / auth / pair.* / welcome. Ordered, one in flight.
 *  - ephemeral   `input` batches and `call.*` frames. Fire-and-forget. Dropped when not
 *                connected, never queued.
 *  - reliable    `cmd` with a client-generated id, answered by exactly one `ack`. The phone
 *                retries un-acked cmds on reconnect; the Mac dedups by id.
 *  - state       Mac -> phone snapshots and deltas with a monotonically increasing `rev` per
 *                topic. A gap (`rev !== known + 1`) means the phone re-requests the snapshot.
 *
 * The Swift mirror lives in apps/mac/Sources/RelayProtocol and is conformance-tested against
 * packages/protocol/fixtures. Change both or neither.
 */
import { z } from "zod";
import { WidgetNode } from "./widget";

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

/**
 * Registry id of one of the host's long-lived assistant threads (e.g. "astra", "nova"). Requests
 * that omit it address the registry's first agent, which is what older phone builds expect.
 */
export const AssistantAgentId = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type AssistantAgentId = z.infer<typeof AssistantAgentId>;

/** The omp profile a session runs on and the email it is signed in with. */
export const AgentAccount = z.object({
  /** `OMP_PROFILE` ("personal", "work"), or "current" for omp's unprofiled default. */
  profile: nonEmpty,
  email: nonEmpty.optional(),
});
export type AgentAccount = z.infer<typeof AgentAccount>;

/**
 * What a session shows for its account: "Personal · <email>" or "Work · <email>". The current
 * profile is Isaac's work login, so anything but "personal" reads as Work.
 */
export function accountLabel(account: AgentAccount): string {
  const kind = account.profile === "personal" ? "Personal" : "Work";
  return account.email === undefined ? kind : `${kind} · ${account.email}`;
}

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
  /**
   * The omp account the session runs on: its profile (`OMP_PROFILE`, "current" when unset) and
   * the email that profile is signed in with, when known. Absent from providers without accounts.
   */
  account: AgentAccount.optional(),
  /**
   * Hand-started, a run the host's job launcher scheduled, or one of the host's long-lived
   * assistant threads (hidden from inbox lists, read through `assistant.get`). Absent on older
   * hosts, which only ever had manual sessions.
   */
  kind: z.enum(["manual", "job", "assistant"]).optional(),
  /** The registry id of the assistant this session runs; present exactly when `kind` is "assistant". */
  assistant: AssistantAgentId.optional(),
  /** The scheduled job this session is a run of; present exactly when `kind` is "job". */
  job: z.object({ name: nonEmpty, runId: nonEmpty }).optional(),
  /**
   * Set on a subagent: the id of the session that spawned it. Phones list subagents under their
   * parent rather than in the inbox. Absent on top-level sessions and from older hosts.
   */
  parentId: nonEmpty.optional(),
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

/** One selectable answer in an ask question: a label, with optional help and a rich preview. */
export const AgentAskOption = z.object({
  label: nonEmpty,
  description: z.string().optional(),
  preview: z.string().optional(),
});
export type AgentAskOption = z.infer<typeof AgentAskOption>;

/** One question omp's `ask` tool poses: a prompt and its options, single- or multi-select. */
export const AgentAskQuestion = z.object({
  id: nonEmpty,
  question: nonEmpty,
  header: z.string().optional(),
  options: z.array(AgentAskOption).min(1),
  multi: z.boolean().optional(),
  /** Index of the option the agent recommends, if any. */
  recommended: z.number().int().nonnegative().optional(),
});
export type AgentAskQuestion = z.infer<typeof AgentAskQuestion>;

/** A pending choice the session is blocked on; the phone renders it and answers with `agent.ask.answer`. */
export const AgentAsk = z.object({
  id: nonEmpty,
  questions: z.array(AgentAskQuestion).min(1),
});
export type AgentAsk = z.infer<typeof AgentAsk>;

/**
 * A tool call omp is blocked on until it is approved or denied. `id` is omp's tool call id;
 * `command` is what omp's own approval prompt shows, verbatim (the shell command for `bash`).
 * When `requiresBiometric` is set the call matches a destructive pattern (force push, `rm -rf`,
 * deploy, prod writes): a phone must have Face ID confirmed before it sends `agent.approve`, and
 * must never offer "always allow" for it. `destructive` names the pattern, for display.
 */
export const AgentApproval = z.object({
  id: nonEmpty,
  toolName: nonEmpty,
  command: z.string(),
  reason: z.string().optional(),
  destructive: nonEmpty.optional(),
  requiresBiometric: z.boolean(),
});
export type AgentApproval = z.infer<typeof AgentApproval>;

/**
 * How the person approving was confirmed. `biometric`: Face ID or Touch ID on the device sending
 * the command. `desktop`: they are at the host's own screen, looking at the command (EvaOS).
 * An approval with `requiresBiometric` is refused without one of them.
 */
export const ApprovalConfirmation = z.enum(["biometric", "desktop"]);
export type ApprovalConfirmation = z.infer<typeof ApprovalConfirmation>;

/**
 * The device id EvaOS pairs with: the escalation engine that decides what reaches the phone. The
 * host suppresses its own "session is waiting" pushes while this device is connected, because the
 * engine already applies the away, 45 s, quiet hours, habit break and rate-limit rules.
 */
export const ESCALATOR_DEVICE_ID = "evaos" as const;

/**
 * Notification categories the phone registers at launch and the host names in an inbox push, so a
 * lock-screen notification carries its actions. A destructive approval gets its own category: its
 * Approve opens the app for Face ID instead of acting from the lock screen.
 */
export const INBOX_CATEGORY = {
  approval: "relay.approval",
  approvalBiometric: "relay.approval.biometric",
  ask: "relay.ask",
} as const;

const InboxItemBase = {
  /** `approval:<approval id>` or `ask:<ask id>` for the two actionable kinds, so the host can name them from a command. */
  id: nonEmpty,
  sessionId: nonEmpty.optional(),
  title: z.string(),
  /** What it is about, verbatim for an agent's question. */
  body: z.string(),
  /** When it began waiting on the Mac, epoch ms. */
  at: ms,
  /** Other items folded into this one's notification ("+1 more"). */
  more: z.number().int().nonnegative().optional(),
  /** Deliver to a connected phone but do not push (a second blocked agent inside the fold window). */
  silent: z.boolean().optional(),
  /**
   * A digest, not something waiting on Isaac: pushed without a sound and without breaking through
   * Focus (`passive`), relayed to connected phones, and not kept to replay or withdraw.
   */
  passive: z.boolean().optional(),
};

/**
 * One thing waiting on Isaac. `approval` items carry omp's approval verbatim, with
 * `requiresBiometric` for destructive calls: Approve then needs Face ID on the phone. `ask` items
 * carry the question's options so a phone answers inline; an ask that has several questions or
 * free text only is an `alert`, answered by opening the app.
 */
export const InboxItem = z.discriminatedUnion("kind", [
  z.object({ ...InboxItemBase, kind: z.literal("approval"), approval: AgentApproval }),
  z.object({
    ...InboxItemBase,
    kind: z.literal("ask"),
    ask: z.object({
      id: nonEmpty,
      questionId: nonEmpty,
      question: z.string(),
      options: z.array(nonEmpty).min(1).max(4),
    }),
  }),
  z.object({ ...InboxItemBase, kind: z.literal("alert") }),
]);
export type InboxItem = z.infer<typeof InboxItem>;

/**
 * Where an item was settled: `mac` (EvaOS, the chat, the terminal) or `phone`. `answer` is the
 * short outcome for display ("Approved", "Denied", or the picked option).
 */
const InboxResolveFields = {
  id: nonEmpty,
  by: z.enum(["mac", "phone"]),
  answer: z.string().optional(),
};
export type InboxResolve = z.infer<z.ZodObject<typeof InboxResolveFields>>;

/** The phone's answer to one question: the chosen option labels, plus any typed input or note. */
export const AgentAskAnswer = z.object({
  id: nonEmpty,
  selectedOptions: z.array(z.string()),
  customInput: z.string().optional(),
  note: z.string().optional(),
});
export type AgentAskAnswer = z.infer<typeof AgentAskAnswer>;

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
/** Longest username or password a sign-in command carries, in UTF-16 code units. */
export const MAX_SIGNIN_FIELD = 1024;
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
  /** True while the assistant is still producing `text`; `agent.message.update` frames carry the growth. */
  streaming: z.boolean().optional(),
});
export type AgentMessage = z.infer<typeof AgentMessage>;

/** Where an assistant's thread stands, from its live omp session: no session is "not_started". */
export const AssistantStatus = z.enum(["working", "needs_you", "idle", "not_started"]);
export type AssistantStatus = z.infer<typeof AssistantStatus>;

/**
 * One assistant thread the host runs, as listed by `assistant.agents`. Everything beyond `id` and
 * `title` is optional so builds from before the Assistants screen keep parsing, and hosts from
 * before it keep parsing here.
 */
export const AssistantAgent = z.object({
  id: AssistantAgentId,
  title: nonEmpty,
  /** What the registry says the agent covers, e.g. "eCard Systems work". */
  scope: z.string().optional(),
  status: AssistantStatus.optional(),
  /** The newest reply of the agent worth showing (never the silence marker), one clipped line. */
  lastReply: z.object({ text: z.string(), at: ms }).optional(),
});
export type AssistantAgent = z.infer<typeof AssistantAgent>;

/**
 * Each assistant is a first-class conversation, separate from omp's operational session inbox.
 * Its durable transcript is owned by the host and replayed on every phone connection.
 */
export const AssistantMessage = z.object({
  id: nonEmpty,
  role: z.enum(["user", "assistant", "card", "status", "error"]),
  text: z.string(),
  title: z.string().optional(),
  at: ms,
  /** Pictures on the row: Isaac's attachments, or screenshots Eva produced. Bytes come from `agent.image` for the snapshot's `sessionId`. */
  images: z.array(AgentImageRef).optional(),
  /** Eva asked Isaac to sign in to a site in her browser: the page and its host. `submitted` once the host typed credentials into the login page. */
  signin: z.object({ url: nonEmpty, host: nonEmpty, submitted: z.boolean().optional() }).optional(),
  /** A user row Isaac said on a call rather than typed (the host strips the voice-turn note from its text). */
  voice: z.boolean().optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const AssistantSnapshot = z.object({
  rev: z.number().int().nonnegative(),
  messages: z.array(AssistantMessage),
  busy: z.boolean(),
  /** The omp session the thread runs in (what `agent.image` takes); empty while the assistant is not running. */
  sessionId: z.string(),
});
export type AssistantSnapshot = z.infer<typeof AssistantSnapshot>;


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
// Live view: the phone watches one host window. `screen.list` asks for the capturable windows;
// `screen.watch` starts a stream of `screen.frame` JPEGs (base64, scaled to about phone width,
// only sent when the window changed) until `screen.stop`, another `screen.watch`, or the socket
// closes. The host drops frames while the socket is backed up, so the phone always sees the latest.
// ---------------------------------------------------------------------------------------------

export const ScreenWindow = z.object({
  /** CGWindowID; stable while the window lives. */
  id: z.number().int().nonnegative(),
  app: z.string(),
  title: z.string(),
  /** Size in points. */
  width: z.number(),
  height: z.number(),
});
export type ScreenWindow = z.infer<typeof ScreenWindow>;

/**
 * Why a watch or list failed. `denied`: the host lacks Screen Recording permission;
 * `gone`: the window closed; `unavailable`: this host cannot capture (no helper, not a Mac);
 * `failed`: anything else.
 */
export const ScreenError = z.enum(["denied", "gone", "unavailable", "failed"]);
export type ScreenError = z.infer<typeof ScreenError>;

/** Named keys the live view can press on the watched window's app. */
export const ScreenKey = z.enum(["return", "delete", "tab", "escape", "left", "right", "up", "down"]);
export type ScreenKey = z.infer<typeof ScreenKey>;

const unit = z.number().min(0).max(1);

// ---------------------------------------------------------------------------------------------
// Calls: a live voice conversation with one assistant thread over this socket (not telephony).
// The phone streams its microphone as `call.audio` (PCM16 LE mono at CALL_INPUT_RATE, base64,
// about 100 ms a frame) and plays the host's `call.audio` (PCM16 LE mono at CALL_OUTPUT_RATE).
// The host finds the utterances (VAD + speech-to-text), hands each one to the assistant as a
// voice turn in its normal thread, and speaks the reply. Speech while the host is talking is a
// barge-in: it sends `call.flush` and starts a new audio generation. A call lives and dies with
// its socket; there is at most one per socket.
// ---------------------------------------------------------------------------------------------

export const CALL_INPUT_RATE = 16_000;
export const CALL_OUTPUT_RATE = 24_000;
/** Largest audio payload (base64 length) one call frame carries, either way: about a second. */
export const MAX_CALL_AUDIO_BASE64 = 64 * 1024;

export const CallId = z.string().min(1).max(64);

/**
 * Where a call stands. `connecting`: the host is warming its speech models; `listening`: waiting
 * for Isaac; `hearing`: he is talking; `thinking`: his words went to the assistant, no reply audio
 * yet; `speaking`: reply (or filler) audio is playing; `ended`: over, `error` says why if it failed.
 */
export const CallState = z.enum(["connecting", "listening", "hearing", "thinking", "speaking", "ended"]);
export type CallState = z.infer<typeof CallState>;

const CallAudio = z.string().min(1).max(MAX_CALL_AUDIO_BASE64);


// ---------------------------------------------------------------------------------------------
// Habit gate: at planned breaks the host locks its AI tools until a habit (or a one-time task) is
// done. The host only relays: the gate's own CLI owns the state, the omp bridge reports it as
// `gate.status` and runs the phone's `gate.start` / `gate.done` / `gate.override` through it.
// ---------------------------------------------------------------------------------------------

/** Longest typed override reason. */
export const MAX_GATE_REASON = 500;

/** A recurring habit; `photo` means `gate.done` needs a proof picture. */
export const GateHabit = z.object({
  id: nonEmpty,
  name: nonEmpty,
  minutes: z.number().nonnegative(),
  photo: z.boolean(),
});
export type GateHabit = z.infer<typeof GateHabit>;

/** A one-time task; `minutes: null` has no timer, `done` ones are no longer offered. */
export const GateTask = z.object({
  id: nonEmpty,
  name: nonEmpty,
  minutes: z.number().nonnegative().nullable(),
  done: z.boolean(),
});
export type GateTask = z.infer<typeof GateTask>;

/** The habit or task whose timer is running; times are ISO 8601. */
export const GateActive = z.object({
  kind: z.enum(["habit", "task"]),
  id: nonEmpty,
  startedAt: nonEmpty,
  endsAt: nonEmpty,
});
export type GateActive = z.infer<typeof GateActive>;

/** Today's planned breaks, placed around the calendar (or evenly spaced when it could not be read). */
export const GatePlan = z.object({
  date: nonEmpty,
  breaks: z.array(z.object({ at: nonEmpty, done: z.boolean() })),
  source: z.enum(["calendar", "fallback"]),
});
export type GatePlan = z.infer<typeof GatePlan>;

/**
 * The gate as its CLI reports it. `blocked`: locked with no finished habit, so AI tools refuse;
 * `canFinish`: the active timer has run out and `gate.done` will be accepted.
 */
export const GateStatus = z.object({
  locked: z.boolean(),
  blocked: z.boolean(),
  reason: z.string().nullable(),
  active: GateActive.nullable(),
  habits: z.array(GateHabit),
  tasks: z.array(GateTask),
  canFinish: z.boolean(),
  remainingSeconds: z.number().nullable(),
  plan: GatePlan.nullable().optional(),
});
export type GateStatus = z.infer<typeof GateStatus>;

// ---------------------------------------------------------------------------------------------
// Boards: live dashboards. A board is a titled grid of widget tiles the host stores as JSON and
// streams to subscribed clients. One global `rev` covers every board; each successful write bumps
// it by one and sends the full changed board (or its removal) as a `board.delta`.
// ---------------------------------------------------------------------------------------------

export const MAX_BOARD_WIDGETS = 48;
export const BOARD_COLUMNS = 12;

/** Board slugs and tile ids: lowercase, file-name safe. */
export const BoardSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const BoardWidgetId = BoardSlug;

const BoardSpan = z.number().int().min(1).max(BOARD_COLUMNS);

/** One tile: a widget spec spanning `span` of the board's 12 columns. */
export const BoardWidget = z.object({
  id: BoardWidgetId,
  span: BoardSpan.default(BOARD_COLUMNS),
  spec: WidgetNode,
});
export type BoardWidget = z.infer<typeof BoardWidget>;

export const BoardTitle = z.string().min(1).max(120);

export const Board = z
  .object({
    slug: BoardSlug,
    title: BoardTitle,
    workspace: z.string().optional(),
    icon: z.string().optional(),
    widgets: z.array(BoardWidget).max(MAX_BOARD_WIDGETS),
    updatedAt: z.string().datetime(),
  })
  .superRefine((board, ctx) => {
    const seen = new Set<string>();
    for (const [index, widget] of board.widgets.entries()) {
      if (seen.has(widget.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["widgets", index, "id"], message: `duplicate widget id ${widget.id}` });
      seen.add(widget.id);
    }
  });
export type Board = z.infer<typeof Board>;

/** Body of a create/replace (`PUT /boards/<slug>`); the host fills `slug` and `updatedAt`. */
export const BoardPut = z.object({
  title: BoardTitle,
  workspace: z.string().optional(),
  icon: z.string().optional(),
  widgets: z.array(BoardWidget).max(MAX_BOARD_WIDGETS).optional(),
});
export type BoardPut = z.infer<typeof BoardPut>;

/**
 * One edit to an existing board. `upsert.after`: the tile id to place it after, null for first;
 * absent keeps an existing tile where it is and appends a new one.
 */
export const BoardOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    id: BoardWidgetId,
    span: BoardSpan.optional(),
    spec: WidgetNode,
    after: BoardWidgetId.nullable().optional(),
  }),
  z.object({ op: z.literal("remove"), id: BoardWidgetId }),
  z.object({ op: z.literal("meta"), title: BoardTitle.optional(), workspace: z.string().optional(), icon: z.string().optional() }),
]);
export type BoardOp = z.infer<typeof BoardOp>;

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
  /**
   * Open a fresh agent session on the host (it shows up in `agents.*` once it registers). With
   * `prompt`, the host hands that text to the new session as its first turn the moment it is ready.
   */
  z.object({
    kind: z.literal("agent.start"),
    prompt: z.string().min(1).max(MAX_DROP_TEXT).optional(),
    /** Thinking level the session opens with; ignored when its model lacks it. */
    thinkingLevel: nonEmpty.optional(),
    /** Isolated omp auth/session profile. Omitted keeps the host's current account. */
    profile: z.enum(["personal", "work"]).optional(),
  }),
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
  /** Answer a pending `agent.ask`: the phone's selections for each question. */
  z.object({
    kind: z.literal("agent.ask.answer"),
    sessionId: nonEmpty,
    askId: nonEmpty,
    results: z.array(AgentAskAnswer).min(1),
  }),
  /** Dismiss a pending `agent.ask` without answering: omp's ask dialog resolves as cancelled. */
  z.object({ kind: z.literal("agent.ask.cancel"), sessionId: nonEmpty, askId: nonEmpty }),
  /**
   * Approve the tool call omp is blocked on (`approvalId` is `AgentApproval.id`); omp then runs
   * it. Destructive calls (`requiresBiometric`) need `confirmed`, else the ack is
   * `biometric_required`.
   */
  z.object({
    kind: z.literal("agent.approve"),
    sessionId: nonEmpty,
    approvalId: nonEmpty,
    confirmed: ApprovalConfirmation.optional(),
  }),
  /** Deny the tool call omp is blocked on; omp reports it denied and carries on. Needs no confirmation. */
  z.object({ kind: z.literal("agent.deny"), sessionId: nonEmpty, approvalId: nonEmpty }),
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
  /** Start the timer of a habit or one-time task (by id) while the gate is locked. */
  z.object({ kind: z.literal("gate.start"), id: nonEmpty }),
  /** Finish the active habit or task; `photo` is the proof a photo habit requires. */
  z.object({ kind: z.literal("gate.done"), id: nonEmpty, photo: AgentImage.optional() }),
  /** Unlock without a habit; the typed reason is logged with the gate's history. */
  z.object({ kind: z.literal("gate.override"), reason: z.string().trim().min(1).max(MAX_GATE_REASON) }),
  /** Give a persistent assistant (`agent`, default the registry's first) a new turn. Text may be empty only when images are present (the host nacks a turn with neither). */
  z.object({
    kind: z.literal("assistant.turn"),
    agent: AssistantAgentId.optional(),
    text: z.string().trim().max(MAX_DROP_TEXT),
    images: z.array(AgentImage).min(1).max(MAX_REPLY_IMAGES).optional(),
  }),
  /**
   * Credentials for the sign-in an assistant (`agent`, default the registry's first) asked for in
   * message `messageId`. The host types them into the login page of `url` in its browser; the
   * model never sees them.
   */
  z.object({
    kind: z.literal("assistant.signin"),
    agent: AssistantAgentId.optional(),
    messageId: nonEmpty,
    url: nonEmpty,
    username: z.string().max(MAX_SIGNIN_FIELD),
    password: z.string().min(1).max(MAX_SIGNIN_FIELD),
  }),
]);
export type Command = z.infer<typeof Command>;

export const AckError = z.object({
  code: z.enum([
    "accessibility_denied",
    "agent_not_found",
    "agent_cannot_respond",
    "biometric_required",
    "agent_launch_failed",
    "agent_configure_failed",
    "invalid_command",
    "internal",
    "drop_unavailable",
    "drop_not_found",
    "gate_unavailable",
    "gate_failed",
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
  /** Start receiving `board.delta` on this socket; answered by `board.snapshot`. */
  z.object({ t: z.literal("board.subscribe") }),
  /** Re-request every board (after a rev gap); answered by `board.snapshot`. */
  z.object({ t: z.literal("board.get") }),
  /** Ask for an assistant's durable conversation (`agent`, default the registry's first); answered by `assistant.snapshot`. */
  z.object({ t: z.literal("assistant.get"), agent: AssistantAgentId.optional() }),
  /** Ask which assistant threads the host runs; answered by `assistant.agents`. */
  z.object({ t: z.literal("assistant.agents") }),
  /** Ask for the habit gate's current state; answered by `gate.status`. */
  z.object({ t: z.literal("gate.get") }),
  /** Ask for the capturable host windows; answered by `screen.list`. */
  z.object({ t: z.literal("screen.list") }),
  /** Stream `windowId` as `screen.frame`s, replacing any watch already running on this socket. */
  z.object({ t: z.literal("screen.watch"), windowId: z.number().int().nonnegative() }),
  /** Stop the running watch, if any. */
  z.object({ t: z.literal("screen.stop") }),
  /**
   * Click the watched window at `x`,`y`, normalized 0..1 over its frame (0,0 top-left). Ephemeral
   * like `input`: ignored unless `windowId` is the window this socket is watching.
   */
  z.object({ t: z.literal("screen.tap"), windowId: z.number().int().nonnegative(), x: unit, y: unit }),
  /**
   * Scroll the watched window by `dx`,`dy` points of the host window (natural direction: positive
   * `dy` moves content down), with the pointer at `x`,`y` (normalized; the window centre if omitted).
   */
  z.object({
    t: z.literal("screen.scroll"),
    windowId: z.number().int().nonnegative(),
    dx: z.number(),
    dy: z.number(),
    x: unit.optional(),
    y: unit.optional(),
  }),
  /** Type `text` or press `key` (exactly one) into the watched window's app. */
  z.object({ t: z.literal("screen.key"), text: z.string().min(1).max(2000).optional(), key: ScreenKey.optional() }),
  /**
   * Trackpad: move the host cursor by raw phone `dx`,`dy` points at phone time `at`; the host
   * accelerates them (PointerModel, like `input` moves) and clamps to the displays. Ephemeral;
   * needs a running watch on this socket.
   */
  z.object({ t: z.literal("screen.move"), dx: z.number().finite(), dy: z.number().finite(), at: ms }),
  /** Trackpad: click `button` wherever the host cursor is. */
  z.object({ t: z.literal("screen.click"), button: z.enum(["left", "right"]) }),
  /**
   * Escalate `item` to the phone. Only the escalator (`ESCALATOR_DEVICE_ID`) may send it; the host
   * stores it, relays it to every other device and pushes a notification for a new id.
   */
  z.object({ t: z.literal("inbox.item"), item: InboxItem }),
  /**
   * An item closed on this device (EvaOS: answered on the Mac or in the chat). The host forgets it,
   * relays the frame to the other devices and withdraws the phone notification. A phone does not
   * send it for its own answer: the host derives it from the `agent.approve`, `agent.deny` or
   * `agent.ask.answer` it carries out.
   */
  z.object({ t: z.literal("inbox.resolve"), ...InboxResolveFields }),
  /** Call assistant `agent` on this socket; ends any call already on it. Answered by `call.state`. */
  z.object({ t: z.literal("call.start"), callId: CallId, agent: AssistantAgentId }),
  /** About 100 ms of microphone, PCM16 LE mono at CALL_INPUT_RATE, base64. Ignored for any other call. */
  z.object({ t: z.literal("call.audio"), callId: CallId, pcm: CallAudio }),
  /** The phone stopped (or resumed) sending its microphone; the host drops any half-heard utterance. */
  z.object({ t: z.literal("call.mute"), callId: CallId, muted: z.boolean() }),
  /** Hang up. The host answers with `call.state` `ended`. */
  z.object({ t: z.literal("call.end"), callId: CallId }),
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
  /**
   * The full text so far of a message that was appended with `streaming: true`. Idempotent and
   * unsequenced: the last one (`streaming: false`) is the final text. Ignored when the phone does
   * not hold `id`; the next `agent.conversation` carries the settled message.
   */
  z.object({ t: z.literal("agent.message.update"), sessionId: nonEmpty, id: nonEmpty, text: z.string(), streaming: z.boolean() }),
  z.object({ t: z.literal("agent.options"), sessionId: nonEmpty, models: z.array(AgentModel), skills: z.array(AgentSkill) }),
  /** The session is blocked on omp's `ask` tool; render the choices and answer with `agent.ask.answer`. */
  z.object({ t: z.literal("agent.ask"), sessionId: nonEmpty, ask: AgentAsk }),
  /** A pending ask was answered or cancelled (from the terminal or another device); dismiss its card. */
  z.object({ t: z.literal("agent.ask.resolved"), sessionId: nonEmpty, id: nonEmpty }),
  /** The session is blocked on a tool approval; answer with `agent.approve` or `agent.deny`. */
  z.object({ t: z.literal("agent.approval"), sessionId: nonEmpty, approval: AgentApproval }),
  /** A pending approval was settled (here, in the terminal or on another device); dismiss it. */
  z.object({ t: z.literal("agent.approval.resolved"), sessionId: nonEmpty, id: nonEmpty }),
  /**
   * An item the escalation engine in EvaOS wants Isaac to see on the phone (`ESCALATOR_DEVICE_ID`
   * sends it, the host relays it to every other device). A new id also pushes a Time Sensitive
   * notification; the same id again (a changed `more`) updates what is already shown, and `silent`
   * skips the push. Replayed to a device right after it authenticates, so a phone never misses
   * one that opened while it was away.
   */
  z.object({ t: z.literal("inbox.item"), item: InboxItem }),
  /** The item closed (answered on the Mac, in the chat, or on a phone); withdraw its notification. */
  z.object({ t: z.literal("inbox.resolve"), ...InboxResolveFields }),
  /** `image` is null when the session no longer has that image. */
  z.object({ t: z.literal("agent.image"), sessionId: nonEmpty, id: nonEmpty, image: AgentImage.nullable() }),
  /** Full durable thread of assistant `agent`, sent on request and after each completed turn. */
  z.object({ t: z.literal("assistant.snapshot"), agent: AssistantAgentId, snapshot: AssistantSnapshot }),
  /** Answer to `assistant.agents`: the host's assistant threads in registry order (the first is the default). */
  z.object({ t: z.literal("assistant.agents"), agents: z.array(AssistantAgent) }),
  /** A drop was added on either side; also mirrored as a push notification for host-origin drops. */
  z.object({ t: z.literal("drop.new"), drop: Drop }),
  z.object({ t: z.literal("drop.removed"), id: nonEmpty }),
  /** Answer to `drop.list`: the whole history, newest first. */
  z.object({ t: z.literal("drop.list"), drops: z.array(Drop).max(MAX_DROPS) }),
  /** Every board at `rev`; the answer to `board.subscribe` and `board.get`. */
  z.object({ t: z.literal("board.snapshot"), rev: z.number().int(), boards: z.array(Board) }),
  /** One write: the changed board in full, or the slug that was deleted (exactly one of the two). */
  z.object({ t: z.literal("board.delta"), rev: z.number().int(), board: Board.optional(), removed: BoardSlug.optional() }),
  /** The habit gate changed, or the answer to `gate.get`. `null`: no bridge reports a gate on this host. */
  z.object({ t: z.literal("gate.status"), gate: GateStatus.nullable() }),
  /** Answer to `screen.list`: capturable windows, front to back. `error` set means none could be listed. */
  z.object({ t: z.literal("screen.list"), windows: z.array(ScreenWindow), error: ScreenError.optional() }),
  /** One captured frame of the watched window: base64 JPEG, `width` x `height` pixels. */
  z.object({
    t: z.literal("screen.frame"),
    windowId: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    jpeg: nonEmpty,
  }),
  /**
   * Where the host cursor is over the watched window, normalized (outside 0..1 when off it).
   * Sent right after every trackpad move and before frames, so the phone draws the cursor itself
   * (frames are captured without one) at input speed rather than frame speed.
   */
  z.object({ t: z.literal("screen.cursor"), windowId: z.number().int().nonnegative(), x: z.number(), y: z.number() }),
  /** The watch ended without the phone asking (window closed, permission missing, capture died). */
  z.object({ t: z.literal("screen.ended"), windowId: z.number().int().nonnegative(), error: ScreenError }),
  /**
   * Where call `callId` with assistant `agent` stands. `text` is what was just heard (`thinking`)
   * or is being said (`speaking`); `error` comes with `ended` when the call failed.
   */
  z.object({
    t: z.literal("call.state"),
    callId: CallId,
    agent: AssistantAgentId,
    state: CallState,
    text: z.string().optional(),
    error: z.string().optional(),
  }),
  /** Reply audio, PCM16 LE mono at CALL_OUTPUT_RATE, base64; play in order, dropping any `gen` below the last `call.flush`. */
  z.object({ t: z.literal("call.audio"), callId: CallId, gen: z.number().int().nonnegative(), pcm: CallAudio }),
  /** Barge-in: stop playback now and drop queued or late audio of generations below `gen`. */
  z.object({ t: z.literal("call.flush"), callId: CallId, gen: z.number().int().nonnegative() }),
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
export * from "./widget";
