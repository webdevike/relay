// The omp AgentProvider: a unix-socket server that every interactive omp session connects to
// via apps/linux/omp-extension/relay-bridge.ts. One connection == one session; the connection
// dropping is the session ending. Frames are JSONL both ways.
//
//   extension -> host   hello (full session info) | status | messages { append } |
//                       result { id, ok, error?, value? }
//   host -> extension   conversation { id } | reply { id, text, submit } | options { id } |
//                       configure { id, ...change } | abort { id }
//
// Sessions are validated with zod at this boundary: a misbehaving extension version can only
// produce a logged parse error, never a malformed frame on the phone's WebSocket.

import { existsSync, unlinkSync } from "node:fs";
import type { Socket, SocketHandler } from "bun";
import { AgentMessage, AgentOptions, AgentSession, AgentStatus, type AgentSession as AgentSessionT, type AgentMessage as AgentMessageT, type AgentOptions as AgentOptionsT } from "@relay/protocol";
import { z } from "zod";
import { AckFailure, type AgentConfigChange, type AgentProvider, type AgentProviderChange } from "../seams";

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
});

const Inbound = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello") }).merge(AgentSession.omit({ id: true })).extend({ sessionId: z.string().min(1) }),
  StatusFrame,
  z.object({ t: z.literal("messages"), append: z.array(AgentMessage).min(1) }),
  z.object({ t: z.literal("result"), id: z.string().min(1), ok: z.boolean(), error: z.string().optional(), value: z.unknown().optional() }),
]);
type Inbound = z.infer<typeof Inbound>;

type RequestKind = "conversation" | "reply" | "options" | "configure" | "abort";

/** The error code a rejected request maps to; the extension's message is passed through. */
const failureCode: Record<RequestKind, AckFailure["error"]["code"]> = {
  conversation: "internal",
  reply: "agent_cannot_respond",
  options: "internal",
  configure: "agent_configure_failed",
  abort: "internal",
};

const REQUEST_TIMEOUT_MS = 5000;
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
  session: AgentSessionT | null;
  readonly pending: Map<string, Pending>;
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
        socket.data = { socket, buffer: "", session: null, pending: new Map() };
        this.connections.add(socket.data);
      },
      data: (socket, chunk) => {
        this.receive(socket.data, chunk);
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

  async reply(sessionId: string, text: string, submit: boolean): Promise<void> {
    await this.request(this.require(sessionId), "reply", { text, submit });
  }

  async options(sessionId: string): Promise<AgentOptionsT | null> {
    const connection = this.find(sessionId);
    if (connection === undefined) return null;
    const parsed = AgentOptions.safeParse(await this.request(connection, "options", {}));
    return parsed.success ? parsed.data : NO_OPTIONS;
  }

  async configure(change: AgentConfigChange): Promise<void> {
    const { sessionId, ...fields } = change;
    await this.request(this.require(sessionId), "configure", fields);
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(this.require(sessionId), "abort", {});
  }

  /**
   * Opens a terminal running omp in `home`, detached from this daemon so a host restart never
   * takes the session with it. The new session registers itself over the socket like any other.
   */
  async launch(): Promise<void> {
    if (this.home === null) {
      throw new AckFailure({ code: "agent_launch_failed", message: "host was started without --agent-home" });
    }
    const proc = Bun.spawn(["setsid", "-f", "alacritty", "--working-directory", this.home, "-e", "omp"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      throw new AckFailure({ code: "agent_launch_failed", message: stderr.length > 0 ? stderr : `launcher exited ${code}` });
    }
    this.log(`launched omp in ${this.home}`);
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
  private request(connection: Connection, t: RequestKind, body: Record<string, unknown>): Promise<unknown> {
    this.requestSeq += 1;
    const id = `${t}-${this.requestSeq}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(new AckFailure({ code: "internal", message: `omp session did not answer ${t} within ${REQUEST_TIMEOUT_MS} ms` }));
    }, REQUEST_TIMEOUT_MS);
    connection.pending.set(id, { resolve, reject, timer, kind: t });
    connection.socket.write(`${JSON.stringify({ t, id, ...body })}\n`);
    return promise;
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
        };
        this.log(`agent session ${frame.sessionId} (${frame.title}) ${frame.status}`);
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
          canRespond: current.canRespond,
          title: frame.title ?? current.title,
          status: frame.status,
          lastActivity: frame.lastActivity,
          lastActivityAt: frame.lastActivityAt,
          ...(frame.statusDetail === undefined ? {} : { statusDetail: frame.statusDetail }),
          ...(frame.model === undefined ? {} : { model: frame.model }),
          ...(frame.modelVendor === undefined ? {} : { modelVendor: frame.modelVendor }),
          ...(frame.thinkingLevel === undefined ? {} : { thinkingLevel: frame.thinkingLevel }),
        };
        this.publish();
        return;
      }
      case "messages":
        if (connection.session === null) return;
        this.onChange?.({ kind: "conversation", sessionId: connection.session.id, appended: frame.append });
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
    }
  }


  private drop(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AckFailure({ code: "agent_not_found", message: "omp session disconnected" }));
    }
    connection.pending.clear();
    connection.socket.end();
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
