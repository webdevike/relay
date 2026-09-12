// Port of RelayServer.swift on Bun.serve: one WebSocket listener, one ClientSession per
// connection. Bun's event loop is the "serial queue": every socket callback and every session
// mutation runs on it, so the session needs no locking. The session never sees the socket; it
// only calls `FrameSink.send`, wired here to `ws.send`.

import { encode, WS_PATH, type ServerMessage } from "@relay/protocol";
import type { Server, ServerWebSocket } from "bun";
import { AgentsDeltaTracker } from "./agents/delta-tracker";
import { CommandDedupStore } from "./dedup";
import { PairingCoordinator } from "./pairing";
import type { AttentionNotifier } from "./push/notifier";
import type { AgentProvider, AgentProviderChange, DeviceStore, FrameSink, InputAccess, InputSink, PairingUI, PushRegistry, TextInjecting } from "./seams";
import { ClientSession } from "./session";

export interface ServerConfig {
  /** 0 picks an ephemeral port, like the Mac app. */
  readonly port: number;
  readonly hostName: string;
  readonly version: string;
}

export interface ServerDeps {
  readonly input: InputSink;
  readonly text: TextInjecting;
  readonly access: InputAccess;
  readonly agents: AgentProvider | null;
  readonly devices: DeviceStore;
  /** Phones' push tokens; null disables `push.register`. */
  readonly push: PushRegistry | null;
  /** Notifies registered phones about sessions that wait on the user; null disables it. */
  readonly notifier: AttentionNotifier | null;
  readonly pairing: PairingUI;
  readonly log: (line: string) => void;
}

export interface ConnectedDevice {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly connectedAt: number;
}

interface SocketData {
  session: ClientSession | null;
  connectedAt: number;
}

type Socket = ServerWebSocket<SocketData>;

class WebSocketFrameSink implements FrameSink {
  private closed = false;

  constructor(private readonly ws: Socket) {}

  send(message: ServerMessage): void {
    if (this.closed) return;
    this.ws.send(encode(message));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
  }
}

export class RelayServer {
  private readonly dedup = new CommandDedupStore();
  private readonly agentsTracker = new AgentsDeltaTracker();
  private readonly pairing: PairingCoordinator;
  private readonly sockets = new Set<Socket>();
  private server: Server<SocketData> | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly deps: ServerDeps,
  ) {
    this.pairing = new PairingCoordinator(deps.pairing);
  }

  /** Returns the bound port. */
  start(): number {
    if (this.server !== null) throw new Error("already started");
    const agents = this.deps.agents;
    if (agents !== null) {
      agents.start();
      this.agentsTracker.seed(agents.sessions);
      this.deps.notifier?.seed(agents.sessions);
      agents.onChange = (change) => {
        this.handleProviderChange(change);
      };
    }
    const server = Bun.serve<SocketData>({
      port: this.config.port,
      hostname: "0.0.0.0",
      fetch: (request, srv) => {
        if (new URL(request.url).pathname !== WS_PATH) return new Response("not found", { status: 404 });
        if (srv.upgrade(request, { data: { session: null, connectedAt: Date.now() } })) return undefined;
        return new Response("websocket upgrade required", { status: 426 });
      },
      websocket: {
        // The phone pings every 5 s; anything quieter than a minute is a dead peer.
        idleTimeout: 60,
        open: (ws) => {
          this.accept(ws);
        },
        message: (ws, raw) => {
          const session = ws.data.session;
          if (session === null) return;
          if (typeof raw !== "string") {
            session.receiveRaw("\u0000binary"); // fails as malformed json -> protocol error
            return;
          }
          session.receiveRaw(raw);
        },
        close: (ws) => {
          ws.data.session?.handleDisconnect();
          this.sockets.delete(ws);
        },
      },
    });
    this.server = server;
    return server.port ?? this.config.port;
  }

  stop(): void {
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
    void this.server?.stop(true);
    this.server = null;
  }

  get connectedDevices(): ConnectedDevice[] {
    const out: ConnectedDevice[] = [];
    for (const ws of this.sockets) {
      const session = ws.data.session;
      if (session === null || !session.isAuthenticated || session.deviceId === null) continue;
      out.push({ deviceId: session.deviceId, deviceName: session.deviceName ?? "", connectedAt: ws.data.connectedAt });
    }
    return out;
  }

  /** Pushes `mac.state` to every authenticated session; call when input access changes. */
  broadcastHostState(): void {
    const message: ServerMessage = {
      t: "mac.state",
      mac: {
        name: this.config.hostName,
        version: this.config.version,
        accessibilityGranted: this.deps.access.granted,
        agentsAvailable: this.deps.agents?.isAvailable ?? false,
      },
    };
    for (const ws of this.sockets) ws.data.session?.broadcast(message);
  }

  /** Whether the phone `deviceId` has `sessionId` open on some live connection. */
  isViewing(deviceId: string, sessionId: string): boolean {
    for (const ws of this.sockets) {
      const session = ws.data.session;
      if (session !== null && session.deviceId === deviceId && session.isSubscribed(sessionId)) return true;
    }
    return false;
  }

  private handleProviderChange(change: AgentProviderChange): void {
    if (change.kind === "sessions") {
      const sessions = this.deps.agents?.sessions ?? [];
      const delta = this.agentsTracker.apply(sessions);
      for (const ws of this.sockets) ws.data.session?.broadcast(delta);
      this.deps.notifier?.observe(sessions);
      return;
    }
    for (const ws of this.sockets) ws.data.session?.agentConversationAppended(change.sessionId, change.appended);
  }

  private accept(ws: Socket): void {
    const session = new ClientSession(
      new WebSocketFrameSink(ws),
      {
        hostName: this.config.hostName,
        version: this.config.version,
        input: this.deps.input,
        text: this.deps.text,
        access: this.deps.access,
        agents: this.deps.agents,
        agentsTracker: this.agentsTracker,
        devices: this.deps.devices,
        push: this.deps.push,
        pairing: this.pairing,
        dedup: this.dedup,
      },
      (closed) => {
        this.deps.log(`disconnected ${closed.deviceName ?? ws.remoteAddress}`);
      },
    );
    ws.data.session = session;
    this.sockets.add(ws);
    this.deps.log(`connection from ${ws.remoteAddress}`);
  }
}
