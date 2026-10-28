// The omp AgentProvider: a unix-socket server that every interactive omp session connects to
// via apps/linux/omp-extension/relay-bridge.ts. One connection == one session; the connection
// dropping is the session ending. Frames are JSONL both ways.
//
//   extension -> host   hello (full session info) | status | messages { append } |
//                       result { id, ok, error?, value? } | gate.status { gate } |
//                       approval.request { id, toolName, command, reason? } | approval.resolved { id }
//   host -> extension   conversation { id } | reply { id, text, submit, images? } | note { id, text } |
//                       options { id } | image { id, imageId } | configure { id, ...change } | abort { id } |
//                       end { id } | gate { id, action, target?, reason?, photo? } | approval { id, approvalId, allow }
//
// Sessions are validated with zod at this boundary: a misbehaving extension version can only
// produce a logged parse error, never a malformed frame on the phone's WebSocket.

import { existsSync, unlinkSync } from "node:fs";
import type { Socket, SocketHandler } from "bun";
import { AgentAccount, AgentAskQuestion, AgentBackgroundJob, AgentGoal, type AgentApproval, type ApprovalConfirmation, AgentImage, AgentMessage, AgentOptions, AgentSession, AgentStatus, GateStatus, type AgentAsk, type AgentAskAnswer, type AgentImage as AgentImageT, type AgentSession as AgentSessionT, type AgentMessage as AgentMessageT, type AgentOptions as AgentOptionsT, type GateStatus as GateStatusT } from "@relay/protocol";
import { z } from "zod";
import { AckFailure, type AgentConfigChange, type AgentProvider, type AgentProviderChange, type GateCommand } from "../seams";
import { destructivePattern } from "./destructive";
import { launchInHerdr, type LaunchOptions } from "./herdr";

const StatusFrame = z.object({
  t: z.literal("status"),
  status: AgentStatus,
  statusDetail: z.string().optional(),
  lastActivity: z.string(),
  lastActivityAt: z.number().finite(),
  title: z.string().min(1).optional(),
  model: z.string().optional(),
  modelVendor: z.string().optional(),
  thinkingLevel: z.string().optional(),
  contextUsed: z.number().min(0).max(1).optional(),
  account: AgentAccount.optional(),
  /** A mirrored subagent stops taking replies when it finishes; top-level sessions never send it. */
  canRespond: z.boolean().optional(),
  /** The transcript on disk, once omp has one; the assistant service keeps it to resume the thread. */
  sessionFile: z.string().min(1).optional(),
  /** Running and just-ended async jobs; absent when there are none. Every status carries the current list. */
  backgroundJobs: z.array(AgentBackgroundJob).optional(),
  /** Set while a handoff or compaction summarizes the session; absent otherwise. */
  handingOff: z.boolean().optional(),
  /** The session's goal while active or paused; absent when it has none. Every status carries the current one. */
  goal: AgentGoal.optional(),
});

const Inbound = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello") }).merge(AgentSession.omit({ id: true })).extend({ sessionId: z.string().min(1), sessionFile: z.string().min(1).optional() }),
  StatusFrame,
  z.object({ t: z.literal("messages"), append: z.array(AgentMessage).min(1) }),
  z.object({ t: z.literal("message.update"), id: z.string().min(1), text: z.string(), streaming: z.boolean() }),
  z.object({ t: z.literal("result"), id: z.string().min(1), ok: z.boolean(), error: z.string().optional(), value: z.unknown().optional() }),
  z.object({ t: z.literal("ask.request"), id: z.string().min(1), questions: z.array(AgentAskQuestion).min(1) }),
  z.object({ t: z.literal("ask.resolved"), id: z.string().min(1) }),
  /** omp is blocked on a tool approval; `command` is its approval prompt's detail lines, verbatim. */
  z.object({ t: z.literal("approval.request"), id: z.string().min(1), toolName: z.string().min(1), command: z.string(), reason: z.string().optional() }),
  z.object({ t: z.literal("approval.resolved"), id: z.string().min(1) }),
  /** Each top-level session polls the gate CLI and reports what it read; `null` when the CLI is missing or failing. */
  z.object({ t: z.literal("gate.status"), gate: GateStatus.nullable() }),
]);
type Inbound = z.infer<typeof Inbound>;

type RequestKind = "conversation" | "reply" | "note" | "options" | "image" | "configure" | "abort" | "end" | "ask" | "approval" | "gate";

/** The error code a rejected request maps to; the extension's message is passed through. */
const failureCode: Record<RequestKind, AckFailure["error"]["code"]> = {
  conversation: "internal",
  reply: "agent_cannot_respond",
  note: "agent_cannot_respond",
  options: "internal",
  image: "internal",
  configure: "agent_configure_failed",
  abort: "internal",
  end: "internal",
  ask: "agent_cannot_respond",
  approval: "agent_cannot_respond",
  gate: "gate_failed",
};

const REQUEST_TIMEOUT_MS = 5000;
/** The gate CLI is a fresh bun process per command, and `done` copies a photo; give it longer. */
const GATE_TIMEOUT_MS = 15_000;
/** A session that answered with something unparseable offers nothing rather than failing the request. */
const NO_OPTIONS: AgentOptionsT = { models: [], skills: [] };

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly kind: RequestKind;
}

interface Connection {
  readonly socket: Socket<Connection>;
  buffer: string;
  /** Outbound bytes the kernel buffer did not take yet; flushed on `drain`. */
  outbound: Buffer | null;
  session: AgentSessionT | null;
  /** Where omp writes this session's transcript, when it told us. */
  sessionFile: string | null;
  readonly pending: Map<string, Pending>;
  /** What this session last read from the gate CLI; undefined until it has reported once. */
  gate: GateStatusT | null | undefined;
}

export function defaultSocketPath(): string {
  const override = process.env["RELAY_AGENTS_SOCKET"];
  if (override !== undefined && override.length > 0) return override;
  return `${process.env["XDG_RUNTIME_DIR"] ?? "/tmp"}/relay-agents.sock`;
}

export class OmpBridgeProvider implements AgentProvider {
  readonly id = "omp";
  onChange: ((change: AgentProviderChange) => void) | null = null;

  private readonly connections = new Set<Connection>();
  private cached: AgentSessionT[] = [];
  private listening = false;
  private requestSeq = 0;
  /** The ask each session is currently blocked on, by omp session id; replayed to phones that subscribe late. */
  private readonly pendingAsks = new Map<string, AgentAsk>();
  /** The tool approval each session is currently blocked on, by omp session id; replayed like asks. */
  private readonly pendingApprovals = new Map<string, AgentApproval>();
  private gateState: GateStatusT | null = null;
  /** `gateState` minus the ticking countdown: a change here is what phones are told about. */
  private gateKey = "null";

  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void,
    /** Directory a phone-started session opens in; `null` disables `agent.start`. */
    private readonly home: string | null,
  ) {}

  get isAvailable(): boolean {
    return this.listening;
  }

  get sessions(): readonly AgentSessionT[] {
    return this.cached;
  }

  start(): void {
    if (this.listening) return;
    if (existsSync(this.path)) unlinkSync(this.path); // stale socket from a previous run
    const handler: SocketHandler<Connection> = {
      open: (socket) => {
        socket.data = { socket, buffer: "", outbound: null, session: null, sessionFile: null, pending: new Map(), gate: undefined };
        this.connections.add(socket.data);
      },
      data: (socket, chunk) => {
        this.receive(socket.data, chunk);
      },
      drain: (socket) => {
        this.flush(socket.data);
      },
      close: (socket) => {
        this.drop(socket.data);
      },
      error: (socket, error) => {
        this.log(`agent bridge socket error: ${error.message}`);
        this.drop(socket.data);
      },
    };
    Bun.listen<Connection>({ unix: this.path, socket: handler });
    this.listening = true;
  }

  async conversation(sessionId: string): Promise<AgentMessageT[] | null> {
    const connection = this.find(sessionId);
    if (connection === undefined) return null;
    const parsed = z.array(AgentMessage).safeParse(await this.request(connection, "conversation", {}));
    return parsed.success ? parsed.data : [];
  }

  async reply(sessionId: string, text: string, submit: boolean, images?: readonly AgentImageT[]): Promise<void> {
    await this.request(this.require(sessionId), "reply", { text, submit, ...(images === undefined ? {} : { images }) });
  }

  /** True only from an extension that knows notes; older ones answer every unknown request with an empty ok. */
  async note(sessionId: string, text: string): Promise<boolean> {
    return (await this.request(this.require(sessionId), "note", { text })) === true;
  }

  async options(sessionId: string): Promise<AgentOptionsT | null> {
    const connection = this.find(sessionId);
    if (connection === undefined) return null;
    const parsed = AgentOptions.safeParse(await this.request(connection, "options", {}));
    return parsed.success ? parsed.data : NO_OPTIONS;
  }

  /** Null for an unknown session or image, and for an answer the extension could not encode. */
  async image(sessionId: string, id: string): Promise<AgentImageT | null> {
    const connection = this.find(sessionId);
    if (connection === undefined) return null;
    const parsed = AgentImage.nullable().safeParse(await this.request(connection, "image", { imageId: id }));
    return parsed.success ? parsed.data : null;
  }

  async configure(change: AgentConfigChange): Promise<void> {
    const { sessionId, ...fields } = change;
    await this.request(this.require(sessionId), "configure", fields);
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(this.require(sessionId), "abort", {});
  }

  async end(sessionId: string): Promise<void> {
    await this.request(this.require(sessionId), "end", {});
  }

  async answerAsk(sessionId: string, askId: string, results: readonly AgentAskAnswer[]): Promise<void> {
    await this.request(this.require(sessionId), "ask", { askId, results });
  }

  async cancelAsk(sessionId: string, askId: string): Promise<void> {
    await this.request(this.require(sessionId), "ask", { askId, cancel: true });
  }

  pendingAsk(sessionId: string): AgentAsk | null {
    return this.pendingAsks.get(sessionId) ?? null;
  }

  async decideApproval(sessionId: string, approvalId: string, allow: boolean, confirmed?: ApprovalConfirmation): Promise<void> {
    const connection = this.require(sessionId);
    const pending = this.pendingApprovals.get(sessionId);
    if (pending?.id !== approvalId) throw new AckFailure({ code: "agent_cannot_respond", message: `approval ${approvalId} already settled` });
    if (allow && pending.requiresBiometric && confirmed === undefined) {
      throw new AckFailure({ code: "biometric_required", message: `${pending.destructive ?? "this call"} needs Face ID or the desktop to approve` });
    }
    await this.request(connection, "approval", { approvalId, allow });
  }

  pendingApproval(sessionId: string): AgentApproval | null {
    return this.pendingApprovals.get(sessionId) ?? null;
  }

  get gate(): GateStatusT | null {
    return this.gateState;
  }

  /** Runs on the session that reported the gate last; its answer is the gate's new state. */
  async runGate(cmd: GateCommand): Promise<void> {
    let reporter: Connection | undefined;
    for (const connection of this.connections) {
      if (connection.gate !== undefined && connection.gate !== null) reporter = connection;
    }
    if (reporter === undefined) {
      throw new AckFailure({ code: "gate_unavailable", message: "no omp session on the host can reach the habit gate" });
    }
    const body =
      cmd.kind === "gate.start"
        ? { action: "start", target: cmd.id }
        : cmd.kind === "gate.done"
          ? { action: "done", target: cmd.id, ...(cmd.photo === undefined ? {} : { photo: cmd.photo }) }
          : { action: "override", reason: cmd.reason };
    const parsed = GateStatus.safeParse(await this.request(reporter, "gate", body, GATE_TIMEOUT_MS));
    if (parsed.success) this.setGate(parsed.data);
  }

  /**
   * Opens a new omp session in its own herdr workspace in `home`. Herdr owns the process, so a
   * host restart never takes the session with it; it registers itself over the socket like any
   * other. `prompt` rides in the pane's env and the session's bridge submits it once omp is up.
   */
  launch(prompt?: string, thinkingLevel?: string, profile?: "personal" | "work"): Promise<void> {
    return this.launchWith({
      ...(prompt === undefined ? {} : { prompt }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(profile === undefined ? {} : { profile }),
    });
  }

  /** `launch` with the full option set: extra pane env and a transcript to resume (the assistant thread). */
  async launchWith(options: LaunchOptions): Promise<void> {
    if (this.home === null) {
      throw new AckFailure({ code: "agent_launch_failed", message: "host was started without --agent-home" });
    }
    const paneId = await launchInHerdr(this.home, this.log, options);
    const what = options.resume === undefined ? `omp${options.profile === undefined ? "" : ` (${options.profile})`}` : `omp resuming ${options.resume}`;
    this.log(`launched ${what} in ${this.home} (herdr pane ${paneId})${options.prompt === undefined ? "" : " with a first prompt"}`);
  }

  /** The transcript file of a live session, when omp reported one; null otherwise. */
  sessionFile(sessionId: string): string | null {
    return this.find(sessionId)?.sessionFile ?? null;
  }

  private find(sessionId: string): Connection | undefined {
    for (const connection of this.connections) {
      if (connection.session?.id === sessionId) return connection;
    }
    return undefined;
  }

  private require(sessionId: string): Connection {
    const connection = this.find(sessionId);
    if (connection === undefined) {
      throw new AckFailure({ code: "agent_not_found", message: "that omp session is no longer running" });
    }
    return connection;
  }

  /**
   * Sends `{ t, id, ...body }` and resolves with the matching `result.value`, or rejects with
   * `AckFailure` when the extension answers `ok: false` or stays silent.
   */
  private request(connection: Connection, t: RequestKind, body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    this.requestSeq += 1;
    const id = `${t}-${this.requestSeq}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(new AckFailure({ code: "internal", message: `omp session did not answer ${t} within ${timeoutMs} ms` }));
    }, timeoutMs);
    connection.pending.set(id, { resolve, reject, timer, kind: t });
    this.write(connection, `${JSON.stringify({ t, id, ...body })}\n`);
    return promise;
  }

  /**
   * `socket.write` takes what fits in the kernel buffer and returns the count; a frame carrying an
   * image is far larger than that, so the rest waits for `drain`. Frames stay in order because
   * anything new goes behind what is already queued.
   */
  private write(connection: Connection, line: string): void {
    const bytes = Buffer.from(line, "utf8");
    connection.outbound = connection.outbound === null ? bytes : Buffer.concat([connection.outbound, bytes]);
    this.flush(connection);
  }

  private flush(connection: Connection): void {
    const queued = connection.outbound;
    if (queued === null) return;
    const written = connection.socket.write(queued);
    connection.outbound = written >= queued.length ? null : queued.subarray(Math.max(written, 0));
  }

  private receive(connection: Connection, chunk: Buffer | Uint8Array): void {
    connection.buffer += Buffer.from(chunk).toString("utf8");
    let newline = connection.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = connection.buffer.slice(0, newline);
      connection.buffer = connection.buffer.slice(newline + 1);
      if (line.trim().length > 0) this.handleLine(connection, line);
      newline = connection.buffer.indexOf("\n");
    }
  }

  private handleLine(connection: Connection, line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.log("agent bridge: dropping non-JSON frame");
      return;
    }
    const parsed = Inbound.safeParse(json);
    if (!parsed.success) {
      this.log(`agent bridge: dropping malformed frame: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      return;
    }
    this.handleFrame(connection, parsed.data);
  }

  private handleFrame(connection: Connection, frame: Inbound): void {
    switch (frame.t) {
      case "hello": {
        // A reconnect from the same session replaces any older connection carrying that id.
        for (const other of this.connections) {
          if (other !== connection && other.session?.id === frame.sessionId) this.drop(other);
        }
        connection.session = {
          id: frame.sessionId,
          provider: frame.provider,
          title: frame.title,
          projectPath: frame.projectPath,
          status: frame.status,
          lastActivity: frame.lastActivity,
          lastActivityAt: frame.lastActivityAt,
          canRespond: frame.canRespond,
          ...(frame.statusDetail === undefined ? {} : { statusDetail: frame.statusDetail }),
          ...(frame.kind === undefined ? {} : { kind: frame.kind }),
          ...(frame.assistant === undefined ? {} : { assistant: frame.assistant }),
          ...(frame.job === undefined ? {} : { job: frame.job }),
          ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
          ...(frame.account === undefined ? {} : { account: frame.account }),
          ...(frame.backgroundJobs === undefined || frame.backgroundJobs.length === 0 ? {} : { backgroundJobs: frame.backgroundJobs }),
          ...(frame.handingOff === true ? { handingOff: true } : {}),
          ...(frame.goal === undefined ? {} : { goal: frame.goal }),
        };
        connection.sessionFile = frame.sessionFile ?? null;
        this.log(`agent session ${frame.sessionId} (${frame.title}) ${frame.status}${frame.account === undefined ? "" : ` on ${frame.account.profile}${frame.account.email === undefined ? "" : ` (${frame.account.email})`}`}`);
        this.publish();
        return;
      }
      case "status": {
        const current = connection.session;
        if (current === null) return;
        connection.session = {
          id: current.id,
          provider: current.provider,
          projectPath: current.projectPath,
          canRespond: frame.canRespond ?? current.canRespond,
          ...(current.kind === undefined ? {} : { kind: current.kind }),
          ...(current.assistant === undefined ? {} : { assistant: current.assistant }),
          ...(current.job === undefined ? {} : { job: current.job }),
          ...(current.parentId === undefined ? {} : { parentId: current.parentId }),
          title: frame.title ?? current.title,
          status: frame.status,
          lastActivity: frame.lastActivity,
          lastActivityAt: frame.lastActivityAt,
          ...(frame.statusDetail === undefined ? {} : { statusDetail: frame.statusDetail }),
          ...(frame.model === undefined ? {} : { model: frame.model }),
          ...(frame.modelVendor === undefined ? {} : { modelVendor: frame.modelVendor }),
          ...(frame.thinkingLevel === undefined ? {} : { thinkingLevel: frame.thinkingLevel }),
          ...(frame.contextUsed === undefined ? {} : { contextUsed: frame.contextUsed }),
          ...((frame.account ?? current.account) === undefined ? {} : { account: frame.account ?? current.account }),
          ...(frame.backgroundJobs === undefined || frame.backgroundJobs.length === 0 ? {} : { backgroundJobs: frame.backgroundJobs }),
          ...(frame.handingOff === true ? { handingOff: true } : {}),
          ...(frame.goal === undefined ? {} : { goal: frame.goal }),
        };
        if (frame.sessionFile !== undefined) connection.sessionFile = frame.sessionFile;
        this.publish();
        return;
      }
      case "messages":
        if (connection.session === null) return;
        this.onChange?.({ kind: "conversation", sessionId: connection.session.id, appended: frame.append });
        return;
      case "message.update":
        if (connection.session === null) return;
        this.onChange?.({ kind: "message", sessionId: connection.session.id, id: frame.id, text: frame.text, streaming: frame.streaming });
        return;
      case "result": {
        const pending = connection.pending.get(frame.id);
        if (pending === undefined) return;
        connection.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.value);
        else pending.reject(new AckFailure({ code: failureCode[pending.kind], message: frame.error ?? `${pending.kind} rejected` }));
        return;
      }
      case "ask.request": {
        if (connection.session === null) return;
        const ask: AgentAsk = { id: frame.id, questions: frame.questions };
        this.pendingAsks.set(connection.session.id, ask);
        this.onChange?.({ kind: "ask", sessionId: connection.session.id, ask });
        return;
      }
      case "ask.resolved": {
        if (connection.session === null) return;
        // Only clear the pending ask if it is the one that resolved: a stale resolve never wipes a newer ask.
        if (this.pendingAsks.get(connection.session.id)?.id === frame.id) this.pendingAsks.delete(connection.session.id);
        this.onChange?.({ kind: "ask.resolved", sessionId: connection.session.id, id: frame.id });
        return;
      }
      case "approval.request": {
        if (connection.session === null) return;
        const destructive = destructivePattern(frame.command);
        const approval: AgentApproval = {
          id: frame.id,
          toolName: frame.toolName,
          command: frame.command,
          ...(frame.reason === undefined ? {} : { reason: frame.reason }),
          ...(destructive === null ? {} : { destructive }),
          requiresBiometric: destructive !== null,
        };
        this.pendingApprovals.set(connection.session.id, approval);
        this.onChange?.({ kind: "approval", sessionId: connection.session.id, approval });
        return;
      }
      case "approval.resolved": {
        if (connection.session === null) return;
        // As with asks: a stale resolve never wipes a newer approval.
        if (this.pendingApprovals.get(connection.session.id)?.id === frame.id) this.pendingApprovals.delete(connection.session.id);
        this.onChange?.({ kind: "approval.resolved", sessionId: connection.session.id, id: frame.id });
        return;
      }
      case "gate.status":
        connection.gate = frame.gate;
        this.setGate(frame.gate);
        return;
    }
  }

  /** Every session reads the same gate file, so the latest report from any of them is the gate. */
  private setGate(gate: GateStatusT | null): void {
    this.gateState = gate;
    const key = gate === null ? "null" : JSON.stringify({ ...gate, remainingSeconds: null });
    if (key === this.gateKey) return;
    this.gateKey = key;
    this.onChange?.({ kind: "gate" });
  }

  private drop(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AckFailure({ code: "agent_not_found", message: "omp session disconnected" }));
    }
    connection.pending.clear();
    if (connection.session !== null) {
      this.pendingAsks.delete(connection.session.id);
      this.pendingApprovals.delete(connection.session.id);
    }
    connection.socket.end();
    // With the last reporting session gone nobody can reach the gate any more.
    if (connection.gate !== undefined && ![...this.connections].some((other) => other.gate !== undefined)) this.setGate(null);
    if (connection.session !== null) {
      this.log(`agent session ${connection.session.id} ended`);
      this.publish();
    }
  }

  /** Recomputes the cached, recency-sorted list and notifies the transport. */
  private publish(): void {
    const sessions: AgentSessionT[] = [];
    for (const connection of this.connections) {
      if (connection.session !== null) sessions.push(connection.session);
    }
    sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    this.cached = sessions;
    this.onChange?.({ kind: "sessions" });
  }
}
