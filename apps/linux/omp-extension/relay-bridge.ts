// omp extension: publishes this session to the Relay Linux host so the phone's Agent Inbox can
// list it, read its conversation, and send follow-up prompts. Install by symlinking this file
// into ~/.omp/agent/extensions/ (global) so every interactive omp session registers itself.
//
// Transport: JSONL over the host's unix socket (see apps/linux/src/agents/bridge.ts for the
// frame contract). The extension reconnects forever with a small backoff, so the host may be
// started or restarted at any time. Headless/subagent sessions (no UI) stay out of the inbox.

import { createConnection, type Socket } from "node:net";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type Model = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

type Status = "working" | "waiting" | "needs_permission" | "idle" | "ended";
type Role = "user" | "assistant" | "tool" | "system";

interface InboxMessage {
  id: string;
  role: Role;
  text: string;
  at: number;
  tool?: { name: string; summary: string };
}

interface Settings {
  title: string;
  model?: string;
  modelVendor?: string;
  thinkingLevel?: string;
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
  | { t: "result"; id: string; ok: boolean; error?: string; value?: unknown };

type Inbound =
  | { t: "conversation"; id: string }
  | { t: "reply"; id: string; text: string; submit: boolean }
  | { t: "options"; id: string }
  | { t: "configure"; id: string; title?: string; model?: { provider: string; id: string }; thinkingLevel?: string }
  | { t: "abort"; id: string };

/** Thinking selectors a model accepts; "off" applies to any model, the rest come from its catalog entry. */
function thinkingLevelsFor(model: Model): ThinkingLevel[] {
  return model.reasoning ? ["off", ...(model.thinking?.efforts ?? [])] : ["off"];
}

const RECONNECT_MS = 3000;
const MAX_SUMMARY = 120;
/** ctx.model is still unresolved during session_start; the settings get a second report after this. */
const SETTINGS_SETTLE_MS = 2000;

export function socketPath(): string {
  const runtime = process.env["RELAY_AGENTS_SOCKET"];
  if (runtime !== undefined && runtime.length > 0) return runtime;
  const base = process.env["XDG_RUNTIME_DIR"] ?? "/tmp";
  return `${base}/relay-agents.sock`;
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
  const history: InboxMessage[] = [];

  const settings = (): Settings => {
    const cwd = ctx?.sessionManager.getCwd() ?? "";
    const base: Settings = { title: pi.getSessionName() ?? basename(cwd) };
    const model = ctx?.model;
    if (model !== undefined) {
      base.model = model.name;
      base.modelVendor = model.identity.class;
    }
    const level = pi.getThinkingLevel();
    if (level !== undefined) base.thinkingLevel = level;
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
      case "reply":
        if (frame.submit) {
          // Same semantics as typing in the TUI and pressing Enter: prompt when idle, steer while streaming.
          pi.sendUserMessage(frame.text);
        } else {
          // Released without the flick: leave it in the editor for the keyboard to finish.
          const existing = ctx.ui.getEditorText();
          ctx.ui.setEditorText(existing.length === 0 ? frame.text : `${existing} ${frame.text}`);
        }
        return undefined;
      case "options":
        return listModelOptions(ctx.modelRegistry.getAvailable());
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

  pi.on("session_start", (_event, context) => {
    if (!context.hasUI) return; // headless, print, and subagent sessions are not inbox items
    ctx = context;
    stopped = false;
    connect();
  });

  pi.on("session_switch", (_event, context) => {
    if (ctx === null) return;
    ctx = context;
    history.length = 0;
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

  pi.on("message_end", (event) => {
    if (ctx === null) return;
    const message = event.message;
    const at = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now();
    const appended: InboxMessage[] = [];
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text.length > 0) appended.push({ id: nextId(), role: message.synthetic === true ? "system" : "user", text, at });
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text.length > 0) appended.push({ id: nextId(), role: "assistant", text, at });
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
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    socket?.end();
    socket = null;
    ctx = null;
  });
}
