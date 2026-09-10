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

type Status = "working" | "waiting" | "needs_permission" | "idle" | "ended";
type Role = "user" | "assistant" | "tool" | "system";

interface InboxMessage {
  id: string;
  role: Role;
  text: string;
  at: number;
  tool?: { name: string; summary: string };
}

interface SessionInfo {
  sessionId: string;
  provider: "omp";
  title: string;
  projectPath: string;
  status: Status;
  statusDetail?: string;
  lastActivity: string;
  lastActivityAt: number;
  canRespond: boolean;
}

type Outbound =
  | ({ t: "hello" } & SessionInfo)
  | { t: "status"; status: Status; statusDetail?: string; lastActivity: string; lastActivityAt: number }
  | { t: "messages"; append: InboxMessage[] }
  | { t: "conversation"; id: string; messages: InboxMessage[] }
  | { t: "reply.result"; id: string; ok: boolean; error?: string };

type Inbound = { t: "reply"; id: string; text: string; submit: boolean } | { t: "conversation"; id: string };

const RECONNECT_MS = 3000;
const MAX_SUMMARY = 120;

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

  const info = (): SessionInfo | null => {
    if (ctx === null) return null;
    const cwd = ctx.sessionManager.getCwd();
    const base: SessionInfo = {
      sessionId: ctx.sessionManager.getSessionId(),
      provider: "omp",
      title: pi.getSessionName() ?? basename(cwd),
      projectPath: cwd,
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
    const frame: Outbound = { t: "status", status, lastActivity, lastActivityAt };
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

  const handleInbound = (frame: Inbound): void => {
    switch (frame.t) {
      case "conversation":
        send({ t: "conversation", id: frame.id, messages: history });
        break;
      case "reply":
        try {
          if (frame.submit) {
            // Same semantics as typing in the TUI and pressing Enter: prompt when idle, steer while streaming.
            pi.sendUserMessage(frame.text);
          } else if (ctx !== null) {
            // Released without the flick: leave it in the editor for the keyboard to finish.
            const existing = ctx.ui.getEditorText();
            ctx.ui.setEditorText(existing.length === 0 ? frame.text : `${existing} ${frame.text}`);
          } else {
            throw new Error("session has no UI");
          }
          send({ t: "reply.result", id: frame.id, ok: true });
        } catch (error) {
          send({ t: "reply.result", id: frame.id, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        break;
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
    });
    next.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) {
          try {
            handleInbound(JSON.parse(line) as Inbound);
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
