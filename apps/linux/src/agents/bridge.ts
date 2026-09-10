// The omp AgentProvider: a unix-socket server that every interactive omp session connects to
// via apps/linux/omp-extension/relay-bridge.ts. One connection == one session; the connection
// dropping is the session ending. Frames are JSONL both ways.
//
//   extension -> host   hello (full session info) | status | messages { append } |
//                       conversation { id, messages } | reply.result { id, ok, error? }
//   host -> extension   reply { id, text } | conversation { id }
//
// Sessions are validated with zod at this boundary: a misbehaving extension version can only
// produce a logged parse error, never a malformed frame on the phone's WebSocket.

import { existsSync, unlinkSync } from "node:fs";
import type { Socket, SocketHandler } from "bun";
import { AgentMessage, AgentSession, AgentStatus, type AgentSession as AgentSessionT, type AgentMessage as AgentMessageT } from "@relay/protocol";
import { z } from "zod";
import { AckFailure, type AgentProvider, type AgentProviderChange } from "../seams";

const StatusFrame = z.object({
  t: z.literal("status"),
  status: AgentStatus,
  statusDetail: z.string().optional(),
  lastActivity: z.string(),
  lastActivityAt: z.number().finite(),
});

const Inbound = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello") }).merge(AgentSession.omit({ id: true })).extend({ sessionId: z.string().min(1) }),
  StatusFrame,
  z.object({ t: z.literal("messages"), append: z.array(AgentMessage).min(1) }),
  z.object({ t: z.literal("conversation"), id: z.string().min(1), messages: z.array(AgentMessage) }),
  z.object({ t: z.literal("reply.result"), id: z.string().min(1), ok: z.boolean(), error: z.string().optional() }),
]);
type Inbound = z.infer<typeof Inbound>;

const REQUEST_TIMEOUT_MS = 5000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
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
    const result = await this.request(connection, "conversation", {});
    const parsed = z.array(AgentMessage).safeParse(result);
    return parsed.success ? parsed.data : [];
  }

  async reply(sessionId: string, text: string, submit: boolean): Promise<void> {
    const connection = this.find(sessionId);
    if (connection === undefined) {
      throw new AckFailure({ code: "agent_not_found", message: "that omp session is no longer running" });
    }
    const result = await this.request(connection, "reply", { text, submit });
    const parsed = z.object({ ok: z.boolean(), error: z.string().optional() }).safeParse(result);
    if (!parsed.success || !parsed.data.ok) {
      throw new AckFailure({ code: "agent_cannot_respond", message: parsed.success ? (parsed.data.error ?? "reply rejected") : "malformed reply result" });
    }
  }

  private find(sessionId: string): Connection | undefined {
    for (const connection of this.connections) {
      if (connection.session?.id === sessionId) return connection;
    }
    return undefined;
  }

  /** Sends `{ t, id, ...body }` and resolves with the matching response payload. */
  private request(connection: Connection, t: "conversation" | "reply", body: Record<string, unknown>): Promise<unknown> {
    this.requestSeq += 1;
    const id = `${t}-${this.requestSeq}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(new AckFailure({ code: "internal", message: `omp session did not answer ${t} within ${REQUEST_TIMEOUT_MS} ms` }));
    }, REQUEST_TIMEOUT_MS);
    connection.pending.set(id, { resolve, reject, timer });
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
          title: current.title,
          projectPath: current.projectPath,
          canRespond: current.canRespond,
          status: frame.status,
          lastActivity: frame.lastActivity,
          lastActivityAt: frame.lastActivityAt,
          ...(frame.statusDetail === undefined ? {} : { statusDetail: frame.statusDetail }),
        };
        this.publish();
        return;
      }
      case "messages":
        if (connection.session === null) return;
        this.onChange?.({ kind: "conversation", sessionId: connection.session.id, appended: frame.append });
        return;
      case "conversation":
        this.settle(connection, frame.id, frame.messages);
        return;
      case "reply.result":
        this.settle(connection, frame.id, { ok: frame.ok, ...(frame.error === undefined ? {} : { error: frame.error }) });
        return;
    }
  }

  private settle(connection: Connection, id: string, value: unknown): void {
    const pending = connection.pending.get(id);
    if (pending === undefined) return;
    connection.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(value);
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
