// omp extension: publishes this session to the Relay Linux host so the phone's Agent Inbox can
// list it, read its conversation, and send follow-up prompts (text and pasted images). Install by
// symlinking this file into ~/.omp/agent/extensions/ (global) so every interactive omp session
// registers itself.
//
// Transport: JSONL over the host's unix socket (see apps/linux/src/agents/bridge.ts for the
// frame contract). The extension reconnects forever with a small backoff, so the host may be
// started or restarted at any time. Headless/subagent sessions (no UI) stay out of the inbox.
//
// Images in the transcript travel as references (id = first 16 hex chars of the sha256 of the
// bytes); the bytes stay here, newest MAX_IMAGES kept, and the host fetches them with `image`.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { basename } from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

type Model = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type SlashCommand = ReturnType<ExtensionAPI["getCommands"]>[number];

type Status = "working" | "waiting" | "needs_permission" | "idle" | "ended";
type Role = "user" | "assistant" | "tool" | "system";

type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

/** Image bytes as they cross the socket in both directions. */
interface Image {
  mimeType: ImageMimeType;
  data: string;
}

interface ImageRef {
  id: string;
  mimeType: ImageMimeType;
  width?: number;
  height?: number;
}

interface InboxMessage {
  id: string;
  role: Role;
  text: string;
  at: number;
  tool?: { name: string; summary: string };
  images?: ImageRef[];
  streaming?: boolean;
}

interface JobRef {
  /** The job folder name (`furry-drop`). */
  name: string;
  /** The launcher's run id (`2026-09-16T2130`). */
  runId: string;
}

interface Settings {
  title: string;
  /** Hand-started omp, or a run the job launcher scheduled; the phone files jobs separately. */
  kind: "manual" | "job";
  job?: JobRef;
  model?: string;
  modelVendor?: string;
  thinkingLevel?: string;
  /** Share of the context window in use, 0..1. */
  contextUsed?: number;
}

interface SessionInfo extends Settings {
  sessionId: string;
  provider: "omp";
  projectPath: string;
  status: Status;
  statusDetail?: string;
  lastActivity: string;
  lastActivityAt: number;
  canRespond: boolean;
}

interface ModelOption {
  provider: string;
  id: string;
  name: string;
  vendor: string;
  thinkingLevels: string[];
}

interface SkillChoice {
  name: string;
  description: string;
  /** Exactly what the host puts before the dictated text (`/handoff`, `/goal set`). */
  command: string;
  /** False: complete on its own, sent as soon as it is picked. */
  takesText: boolean;
}

interface SkillOption extends SkillChoice {
  /** Subcommands, when the command has them; the phone opens them as a second ring. */
  choices?: SkillChoice[];
}

const SKILL_COMMAND_PREFIX = "skill:";

/**
 * What the phone's wheel offers, in omp's own order: authored skills first, then prompt and
 * extension commands, then the built-ins that take an argument. A built-in with subcommands is
 * one entry whose choices are the subcommands (`/goal` → set, show, pause...); a subcommand with
 * a usage takes dictated text, the rest are complete on their own.
 */
function listSkillOptions(commands: readonly SlashCommand[]): SkillOption[] {
  const skills: SkillOption[] = [];
  const others: SkillOption[] = [];
  for (const command of commands) {
    const option = { name: command.name, description: command.description ?? "", command: `/${command.name}`, takesText: true };
    if (command.source === "skill" && command.name.startsWith(SKILL_COMMAND_PREFIX)) {
      skills.push({ ...option, name: command.name.slice(SKILL_COMMAND_PREFIX.length) });
    } else {
      others.push(option);
    }
  }
  const builtins: SkillOption[] = [];
  for (const command of BUILTIN_SLASH_COMMAND_DEFS) {
    const takesText = command.allowArgs === true;
    if (command.subcommands !== undefined) {
      const choices = command.subcommands.map((sub) => ({
        name: sub.name,
        description: sub.description ?? "",
        command: `/${command.name} ${sub.name}`,
        takesText: sub.usage !== undefined,
      }));
      builtins.push({ name: command.name, description: command.description, command: `/${command.name}`, takesText, choices });
      continue;
    }
    if (!takesText) continue;
    builtins.push({ name: command.name, description: command.description, command: `/${command.name}`, takesText });
  }
  return [...skills, ...others, ...builtins];
}

/** Numeric compare of "major.minor.patch" revisions; unknown revisions sort last. */
function compareRevision(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (right[i] ?? 0) - (left[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** "Claude 4.1 Opus" and "Claude Opus 4.1" are the same product: compare the words, not the order. */
function productKey(model: Model): string {
  const words = model.name.toLowerCase().split(/\s+/).sort().join(" ");
  return `${model.provider}/${model.identity.class}/${words}`;
}

/**
 * Models the phone can offer: one entry per product (date-stamped snapshots and reordered-name
 * aliases collapse into the shortest id), grouped by vendor with the newest revision first.
 */
function listModelOptions(models: readonly Model[]): ModelOption[] {
  const byProduct = new Map<string, Model>();
  for (const model of models) {
    const key = productKey(model);
    const existing = byProduct.get(key);
    // Snapshot ids carry a date suffix and legacy aliases are longer; the shortest id follows upgrades.
    if (existing === undefined || model.id.length < existing.id.length) byProduct.set(key, model);
  }
  return [...byProduct.values()]
    .sort((a, b) => a.identity.class.localeCompare(b.identity.class) || compareRevision(a.identity.revision, b.identity.revision) || a.name.localeCompare(b.name))
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      vendor: model.identity.class,
      thinkingLevels: thinkingLevelsFor(model),
    }));
}

type Outbound =
  | ({ t: "hello" } & SessionInfo)
  | ({ t: "status"; status: Status; statusDetail?: string; lastActivity: string; lastActivityAt: number } & Settings)
  | { t: "messages"; append: InboxMessage[] }
  | { t: "message.update"; id: string; text: string; streaming: boolean }
  | { t: "result"; id: string; ok: boolean; error?: string; value?: unknown };

type Inbound =
  | { t: "conversation"; id: string }
  | { t: "reply"; id: string; text: string; submit: boolean; images?: Image[] }
  | { t: "options"; id: string }
  | { t: "image"; id: string; imageId: string }
  | { t: "configure"; id: string; title?: string; model?: { provider: string; id: string }; thinkingLevel?: string }
  | { t: "abort"; id: string }
  | { t: "end"; id: string };

/** Thinking selectors a model accepts; "off" applies to any model, the rest come from its catalog entry. */
function thinkingLevelsFor(model: Model): ThinkingLevel[] {
  return model.reasoning ? ["off", ...(model.thinking?.efforts ?? [])] : ["off"];
}

const RECONNECT_MS = 3000;
const MAX_SUMMARY = 120;
/** ctx.model is still unresolved during session_start; the settings get a second report after this. */
const SETTINGS_SETTLE_MS = 2000;
/** Time for the fed Enter to clear the editor before a held draft is put back. */
const SUBMIT_SETTLE_MS = 150;
/** Transcript images kept per session for the phone to fetch; older ones answer null. */
const MAX_IMAGES = 32;
const IMAGE_ID_LENGTH = 16;

export function socketPath(): string {
  const runtime = process.env["RELAY_AGENTS_SOCKET"];
  if (runtime !== undefined && runtime.length > 0) return runtime;
  const base = process.env["XDG_RUNTIME_DIR"] ?? "/tmp";
  return `${base}/relay-agents.sock`;
}

/**
 * The job launcher (`.omp/tools/job-run.ts`) starts omp with `JOB_NAME` and `JOB_RUN` set; without
 * both this is a hand-started session. Read once: the env does not change under a running session.
 */
function jobRef(): JobRef | undefined {
  const name = process.env["JOB_NAME"];
  const runId = process.env["JOB_RUN"];
  if (name === undefined || name.length === 0 || runId === undefined || runId.length === 0) return undefined;
  return { name, runId };
}
const JOB = jobRef();
/** Local wall-clock start, "HH:MM": the job's default title carries it so runs of one job tell apart. */
const JOB_START = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Where this session sits in Herdr, from the env Herdr gives every pane it launches. The tab
 * is always ours to name; the workspace only when the relay host created it for this session
 * (`RELAY_HERDR_OWNED=1`, set by apps/linux/src/agents/herdr.ts) rather than Isaac's shared one.
 */
interface HerdrSlot {
  tab: string;
  workspace: string | undefined;
}
function herdrSlot(): HerdrSlot | undefined {
  const tab = process.env["HERDR_TAB_ID"];
  if (tab === undefined || tab.length === 0) return undefined;
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  const owned = process.env["RELAY_HERDR_OWNED"] === "1" && workspace !== undefined && workspace.length > 0;
  return { tab, workspace: owned ? workspace : undefined };
}
const HERDR = herdrSlot();
const MAX_HERDR_LABEL = 48;

/** Mirrors omp's session title onto the Herdr tab (and workspace, when it is ours). Fire and forget. */
function renameInHerdr(title: string): void {
  if (HERDR === undefined) return;
  const label = title.length > MAX_HERDR_LABEL ? `${title.slice(0, MAX_HERDR_LABEL - 1)}…` : title;
  const rename = (args: string[]): void => {
    execFile("herdr", args, { timeout: 3000 }, () => {
      // Best effort: a missing herdr or a closed pane must not touch the session.
    });
  };
  rename(["tab", "rename", HERDR.tab, label]);
  if (HERDR.workspace !== undefined) rename(["workspace", "rename", HERDR.workspace, label]);
}

function firstLine(text: string): string {
  const line = text.trim().split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

function summarizeArguments(args: Record<string, unknown>): string {
  const intent = args["i"];
  if (typeof intent === "string" && intent.length > 0) return firstLine(intent);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") parts.push(`${key}=${firstLine(value)}`);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${String(value)}`);
    if (parts.join(" ").length > MAX_SUMMARY) break;
  }
  return firstLine(parts.join(" "));
}

/** Text of a user/assistant message: string content or the joined text parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

/** PNG by signature, JPEG by SOI, WebP by RIFF header (omp re-encodes attachments to WebP); anything else is skipped. */
function sniffMimeType(bytes: Buffer): ImageMimeType | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** WebP size from the first chunk: VP8X canvas, VP8L 14-bit fields, or the VP8 key frame header. */
function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ") {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/** Pixel size from the PNG IHDR, the WebP header, or the first JPEG SOF marker; null when the header is not there. */
function imageSize(bytes: Buffer, mimeType: ImageMimeType): { width: number; height: number } | null {
  if (mimeType === "image/png") {
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mimeType === "image/webp") return webpSize(bytes);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // fill byte before a marker
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any frame header
    const length = bytes.readUInt16BE(offset + 2);
    // Frame headers (SOFn) carry the dimensions; DHT (C4), JPG (C8) and DAC (CC) share the range but do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

export default function relayBridge(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | null = null;
  let socket: Socket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let buffer = "";
  let seq = 0;
  let status: Status = "idle";
  let lastActivity = "";
  let lastActivityAt = Date.now();
  let statusDetail: string | undefined;
  /** The last assistant message of the current turn ended with a question and no tool call followed. */
  let askedQuestion = false;
  /** Stops the session-name subscription of the current context (auto titles, /rename, replan refresh). */
  let unwatchName: (() => void) | null = null;
  const history: InboxMessage[] = [];
  /** Insertion-ordered so the oldest entry is the first key; capped at MAX_IMAGES. */
  const images = new Map<string, Image>();

  /** Interns one transcript image: stores the bytes under their content hash and returns the ref for the phone. */
  const intern = (part: ImageContent): ImageRef | null => {
    const bytes = Buffer.from(part.data, "base64");
    const mimeType = sniffMimeType(bytes);
    if (mimeType === null) return null;
    const id = createHash("sha256").update(bytes).digest("hex").slice(0, IMAGE_ID_LENGTH);
    images.delete(id); // re-insert so a repeated image counts as newest
    images.set(id, { mimeType, data: part.data });
    while (images.size > MAX_IMAGES) {
      const oldest = images.keys().next();
      if (oldest.done === true) break;
      images.delete(oldest.value);
    }
    const ref: ImageRef = { id, mimeType };
    const size = imageSize(bytes, mimeType);
    if (size !== null) {
      ref.width = size.width;
      ref.height = size.height;
    }
    return ref;
  };

  /** Refs for every image part of a message's content; string content has none. */
  const imagesOf = (content: string | readonly (TextContent | ImageContent)[]): ImageRef[] => {
    if (typeof content === "string") return [];
    const refs: ImageRef[] = [];
    for (const part of content) {
      if (part.type !== "image") continue;
      const ref = intern(part);
      if (ref !== null) refs.push(ref);
    }
    return refs;
  };

  const settings = (): Settings => {
    const cwd = ctx?.sessionManager.getCwd() ?? "";
    const fallbackTitle = JOB === undefined ? basename(cwd) : `${JOB.name} · ${JOB_START}`;
    const base: Settings = { title: pi.getSessionName() ?? fallbackTitle, kind: JOB === undefined ? "manual" : "job" };
    if (JOB !== undefined) base.job = JOB;
    const model = ctx?.model;
    if (model !== undefined) {
      base.model = model.name;
      base.modelVendor = model.identity.class;
    }
    const level = pi.getThinkingLevel();
    if (level !== undefined) base.thinkingLevel = level;
    const usage = ctx?.getContextUsage();
    if (usage !== undefined && Number.isFinite(usage.percent)) base.contextUsed = Math.min(1, Math.max(0, usage.percent / 100));
    return base;
  };

  const info = (): SessionInfo | null => {
    if (ctx === null) return null;
    const base: SessionInfo = {
      ...settings(),
      sessionId: ctx.sessionManager.getSessionId(),
      provider: "omp",
      projectPath: ctx.sessionManager.getCwd(),
      status,
      lastActivity,
      lastActivityAt,
      canRespond: true,
    };
    if (statusDetail !== undefined) base.statusDetail = statusDetail;
    return base;
  };

  const send = (frame: Outbound): void => {
    if (socket === null || socket.destroyed || !socket.writable) return;
    socket.write(`${JSON.stringify(frame)}\n`);
  };

  const sendStatus = (): void => {
    const frame: Outbound = { t: "status", status, lastActivity, lastActivityAt, ...settings() };
    if (statusDetail !== undefined) frame.statusDetail = statusDetail;
    send(frame);
  };

  const nextId = (): string => {
    seq += 1;
    return `${Date.now()}-${seq}`;
  };

  const record = (message: InboxMessage): void => {
    history.push(message);
    if (history.length > 500) history.splice(0, history.length - 500);
  };

  const handleInbound = async (frame: Inbound): Promise<void> => {
    try {
      send({ t: "result", id: frame.id, ok: true, value: await perform(frame) });
    } catch (error) {
      send({ t: "result", id: frame.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const perform = async (frame: Inbound): Promise<unknown> => {
    if (ctx === null) throw new Error("session has no UI");
    switch (frame.t) {
      case "conversation":
        return history;
      case "reply": {
        const existing = ctx.ui.getEditorText();
        if (frame.images !== undefined && frame.images.length > 0) {
          // Images only ever go out as a user turn (the host rejects them without `submit`). A
          // slash command with images is sent the same way: sendUserMessage skips command dispatch,
          // so the model sees the literal text next to the pictures rather than the command running.
          const parts: (TextContent | ImageContent)[] = frame.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
          if (frame.text.length > 0) parts.unshift({ type: "text", text: frame.text });
          pi.sendUserMessage(parts);
        } else if (!frame.submit) {
          // Released without the flick: leave it in the editor for the keyboard to finish.
          ctx.ui.setEditorText(existing.length === 0 ? frame.text : `${existing} ${frame.text}`);
        } else if (frame.text.startsWith("/")) {
          // A slash command only runs through the editor's own submit path (sendUserMessage skips
          // command handling), so it goes in as if typed and Enter is fed to the terminal reader.
          // Whatever draft was there comes back once the command has been taken, and the settings
          // are re-reported since commands like /rename and /switch change them without an event.
          ctx.ui.setEditorText(frame.text);
          process.stdin.push("\r");
          setTimeout(() => {
            if (existing.length > 0) ctx?.ui.setEditorText(existing);
            sendStatus();
          }, SUBMIT_SETTLE_MS).unref();
        } else {
          // Same semantics as typing in the TUI and pressing Enter: prompt when idle, steer while streaming.
          pi.sendUserMessage(frame.text);
        }
        return undefined;
      }
      case "image":
        return images.get(frame.imageId) ?? null;
      case "options":
        return { models: listModelOptions(ctx.modelRegistry.getAvailable()), skills: listSkillOptions(pi.getCommands()) };
      case "configure": {
        if (frame.title !== undefined) await pi.setSessionName(frame.title);
        if (frame.model !== undefined) {
          const model = ctx.modelRegistry.find(frame.model.provider, frame.model.id);
          if (model === undefined) throw new Error(`unknown model ${frame.model.provider}/${frame.model.id}`);
          if (!(await pi.setModel(model))) throw new Error(`no API key for ${model.name}`);
        }
        if (frame.thinkingLevel !== undefined) {
          const requested = frame.thinkingLevel;
          const level = ctx.model === undefined ? undefined : thinkingLevelsFor(ctx.model).find((candidate) => candidate === requested);
          if (level === undefined) throw new Error(`${requested} is not a thinking level ${ctx.model?.name ?? "this model"} supports`);
          pi.setThinkingLevel(level);
        }
        sendStatus();
        return undefined;
      }
      case "abort":
        ctx.abort();
        return undefined;
      case "end":
        // `ctx.shutdown()` only flags a request the TUI checks after its next submission, so the
        // exit goes in as the user's own `/exit` on the next turn, once the ack has left.
        setTimeout(() => {
          if (ctx === null) return;
          ctx.ui.setEditorText("/exit");
          process.stdin.push("\r");
        }, 0).unref();
        return undefined;
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
    reconnectTimer.unref();
  };

  const connect = (): void => {
    if (stopped || socket !== null) return;
    const current = info();
    if (current === null) return;
    const next = createConnection(socketPath());
    socket = next;
    buffer = "";
    next.setNoDelay(true);
    next.on("connect", () => {
      send({ t: "hello", ...current, status, lastActivity, lastActivityAt });
      // ctx.model is still unresolved during session_start; report the settings once it is.
      setTimeout(sendStatus, SETTINGS_SETTLE_MS).unref();
    });
    next.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) {
          try {
            void handleInbound(JSON.parse(line) as Inbound);
          } catch {
            // A malformed host frame must never take the session down.
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    const drop = (): void => {
      if (socket === next) socket = null;
      next.destroy();
      scheduleReconnect();
    };
    next.on("error", drop);
    next.on("close", drop);
  };

  const setStatus = (nextStatus: Status, activity?: string, detail?: string): void => {
    status = nextStatus;
    statusDetail = detail;
    if (activity !== undefined && activity.length > 0) lastActivity = activity;
    lastActivityAt = Date.now();
    sendStatus();
  };

  // The title changes outside any extension event: omp generates one asynchronously after the
  // first turn (often after agent_end on a short turn), refreshes it on a todo replan, and /rename
  // in the TUI fires nothing. ctx.sessionManager is typed read-only but is the real manager, which
  // exposes the name-change subscription.
  const watchName = (context: ExtensionContext): void => {
    unwatchName?.();
    const manager = context.sessionManager as SessionManager;
    unwatchName = manager.onSessionNameChanged(() => {
      if (ctx !== context) return;
      const name = pi.getSessionName();
      if (name !== undefined && name.length > 0) renameInHerdr(name);
      sendStatus();
    });
  };

  pi.on("session_start", (_event, context) => {
    if (!context.hasUI) return; // headless, print, and subagent sessions are not inbox items
    ctx = context;
    stopped = false;
    watchName(context);
    connect();
  });

  pi.on("session_switch", (_event, context) => {
    if (ctx === null) return;
    ctx = context;
    watchName(context);
    history.length = 0;
    images.clear();
    const current = info();
    if (current !== null) send({ t: "hello", ...current });
  });

  pi.on("agent_start", () => {
    if (ctx === null) return;
    setStatus("working");
  });

  pi.on("agent_end", () => {
    if (ctx === null) return;
    // A turn that ends on a question is the agent waiting on the user, not merely idle.
    setStatus(askedQuestion ? "waiting" : "idle");
  });

  pi.on("tool_execution_start", (event) => {
    if (ctx === null) return;
    setStatus("working", undefined, event.toolName);
  });

  pi.on("tool_approval_requested", (event) => {
    if (ctx === null) return;
    setStatus("needs_permission", undefined, event.toolName);
  });

  pi.on("tool_approval_resolved", () => {
    if (ctx === null) return;
    setStatus("working");
  });

  // Assistant text streams: one transcript row is appended empty at message_start, its text
  // grows through throttled updates, and message_end settles it and adds the tool rows.
  let streaming: InboxMessage | null = null;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  const STREAM_INTERVAL_MS = 120;

  const flushStream = (final: boolean): void => {
    if (streamTimer !== null) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    if (streaming === null) return;
    send({ t: "message.update", id: streaming.id, text: streaming.text, streaming: !final });
  };

  pi.on("message_start", (event) => {
    if (ctx === null || event.message.role !== "assistant") return;
    const at = "timestamp" in event.message && typeof event.message.timestamp === "number" ? event.message.timestamp : Date.now();
    streaming = { id: nextId(), role: "assistant", text: "", at, streaming: true };
    record(streaming);
    send({ t: "messages", append: [streaming] });
  });

  pi.on("message_update", (event) => {
    if (ctx === null || streaming === null || event.message.role !== "assistant") return;
    streaming.text = textOf(event.message.content);
    if (streamTimer === null) {
      streamTimer = setTimeout(() => {
        streamTimer = null;
        flushStream(false);
      }, STREAM_INTERVAL_MS);
    }
  });

  pi.on("message_end", (event) => {
    if (ctx === null) return;
    const message = event.message;
    const at = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now();
    const appended: InboxMessage[] = [];
    if (message.role === "user") {
      const text = textOf(message.content);
      const refs = imagesOf(message.content);
      if (text.length > 0 || refs.length > 0) {
        const item: InboxMessage = { id: nextId(), role: message.synthetic === true ? "system" : "user", text, at };
        if (refs.length > 0) item.images = refs;
        appended.push(item);
      }
    } else if (message.role === "toolResult") {
      // Only a result that carries pictures (a rendered page, a screenshot) is worth a transcript entry.
      const refs = imagesOf(message.content);
      if (refs.length > 0) appended.push({ id: nextId(), role: "tool", text: "", at, tool: { name: message.toolName, summary: "" }, images: refs });
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (streaming !== null) {
        streaming.text = text;
        delete streaming.streaming;
        flushStream(true);
        if (text.length === 0) {
          // A tool-only turn: drop the empty row from history; the phone's update leaves it blank.
          const index = history.indexOf(streaming);
          if (index !== -1) history.splice(index, 1);
        }
        streaming = null;
      } else if (text.length > 0) {
        appended.push({ id: nextId(), role: "assistant", text, at });
      }
      let calledTool = false;
      for (const part of message.content) {
        if (part.type === "toolCall") {
          calledTool = true;
          const summary = summarizeArguments(part.arguments);
          appended.push({ id: nextId(), role: "tool", text: summary, at, tool: { name: part.name, summary } });
        }
      }
      askedQuestion = !calledTool && text.trimEnd().endsWith("?");
      if (text.length > 0) {
        lastActivity = firstLine(text);
        lastActivityAt = at;
        sendStatus();
      }
    }
    if (appended.length === 0) return;
    for (const item of appended) record(item);
    send({ t: "messages", append: appended });
  });

  pi.on("session_shutdown", () => {
    if (ctx === null) return;
    setStatus("ended");
    stopped = true;
    unwatchName?.();
    unwatchName = null;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    socket?.end();
    socket = null;
    ctx = null;
  });
}
