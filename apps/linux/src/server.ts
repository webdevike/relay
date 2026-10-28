// Port of RelayServer.swift on Bun.serve: one WebSocket listener, one ClientSession per
// connection. Bun's event loop is the "serial queue": every socket callback and every session
// mutation runs on it, so the session needs no locking. The session never sees the socket; it
// only calls `FrameSink.send`, wired here to `ws.send`.

import { ESCALATOR_DEVICE_ID, encode, MAX_DROP_BYTES, VNC_PATH, WS_PATH, type ServerMessage } from "@relay/protocol";
import { basename } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { AgentsDeltaTracker } from "./agents/delta-tracker";
import { handleAssistantSay } from "./assistant/http";
import { handleCatchUpBounce } from "./catchup/http";
import { handleBoardRequest, isLoopback } from "./boards/http";
import { authorizeCanvasSocket, handleCanvasRequest } from "./canvas/http";
import type { CanvasPeer } from "./canvas/room";
import type { CanvasRoom, CanvasService } from "./canvas/service";
import type { FileBoardStore } from "./boards/store";
import type { UsageService } from "./usage/service";
import type { CatchUpDeck } from "./catchup/service";
import type { ReactionRelaying } from "./reactions/service";
import { handleAgentReaction } from "./reactions/http";
import type { ArtifactRelaying } from "./artifacts/service";
import { CommandDedupStore } from "./dedup";
import { serveBlob } from "./drops/serve";
import { isVideoMime, videoMimeOf, VideoTooLarge } from "./drops/video";
import { PairingCoordinator } from "./pairing";
import type { AttentionNotifier } from "./push/notifier";
import type {
  AgentProvider,
  AgentProviderChange,
  AssistantRelaying,
  CallRelaying,
  DeviceStore,
  DropBox,
  DropChange,
  FrameSink,
  ImagePasting,
  InboxRelaying,
  InputAccess,
  InputSink,
  PairingUI,
  PushRegistry,
  TextInjecting,
} from "./seams";
import { ClientSession } from "./session";
import { authorizeVnc, VncBridge, VncTickets } from "./vnc";

export interface ServerConfig {
  /** 0 picks an ephemeral port, like the Mac app. */
  readonly port: number;
  readonly hostName: string;
  readonly version: string;
  /** The Mac's VNC server (Screen Sharing) on 127.0.0.1; the live view's `VNC_PATH` bridges to it. */
  readonly vncPort: number;
}

export interface ServerDeps {
  readonly input: InputSink;
  readonly text: TextInjecting;
  readonly access: InputAccess;
  readonly images: ImagePasting;
  readonly agents: AgentProvider | null;
  readonly devices: DeviceStore;
  /** Phones' push tokens; null disables `push.register`. */
  readonly push: PushRegistry | null;
  /** Notifies registered phones about sessions that wait on the user; null disables it. */
  readonly notifier: AttentionNotifier | null;
  /** The shared drop box; null disables `/drops` and the drop frames. */
  readonly drops: DropBox | null;
  /** Live dashboards; null disables `/boards` and leaves `board.subscribe` an empty snapshot. */
  readonly boards: FileBoardStore | null;
  /** The phone-escalation inbox EvaOS feeds; null disables `inbox.*` frames. */
  readonly inbox: InboxRelaying | null;
  /** The host's assistant threads; null disables `assistant.*` frames and `POST /assistant/say`. */
  readonly assistant: AssistantRelaying | null;
  /** Voice calls with the assistant threads; null disables `call.*` frames. */
  readonly calls: CallRelaying | null;
  /** Plan usage of the host's omp accounts; null answers `usage.*` with an empty snapshot. */
  readonly usage: UsageService | null;
  /** The Catch Up deck; null answers `catchup.*` with an empty deck. */
  readonly catchup: CatchUpDeck | null;
  /** Reactions on chat bubbles; null answers `reactions.get` empty and drops set/clear. */
  readonly reactions: ReactionRelaying | null;
  /** Per-thread artifacts; null answers `artifacts.get` with empty default tabs and refuses acts. */
  readonly artifacts: ArtifactRelaying | null;
  /** Live canvas rooms; null disables `/canvas` and answers `canvas.*` empty. */
  readonly canvas: CanvasService | null;
  /** The canvas web client's HTML, served at `/canvas/<slug>/`. */
  readonly canvasPage: () => string;
  readonly pairing: PairingUI;
  readonly log: (line: string) => void;
}

export interface ConnectedDevice {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly connectedAt: number;
}

/**
 * A relay socket carries a session; a `VNC_PATH` socket carries a bridge instead, and a
 * `/canvas/<slug>/ws` socket a canvas room's peer (`session` null for both).
 */
interface SocketData {
  session: ClientSession | null;
  connectedAt: number;
  vnc: { readonly deviceId: string; bridge: VncBridge | null } | null;
  canvas: { readonly room: CanvasRoom; peer: CanvasPeer | null } | null;
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
  private readonly vncSockets = new Set<Socket>();
  private readonly canvasSockets = new Set<Socket>();
  private readonly vncTickets: VncTickets;
  private server: Server<SocketData> | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly deps: ServerDeps,
  ) {
    this.pairing = new PairingCoordinator(deps.pairing);
    this.vncTickets = new VncTickets(config.vncPort);
  }

  /** Returns the bound port. */
  start(): number {
    if (this.server !== null) throw new Error("already started");
    const drops = this.deps.drops;
    if (drops !== null) {
      drops.onChange = (change) => {
        this.handleDropChange(change);
      };
    }
    const canvas = this.deps.canvas;
    if (canvas !== null) {
      canvas.onChange = () => {
        const message = canvas.snapshot();
        for (const ws of this.sockets) ws.data.session?.broadcast(message);
      };
    }
    const boards = this.deps.boards;
    if (boards !== null) {
      boards.onChange = (delta) => {
        for (const ws of this.sockets) ws.data.session?.boardChanged(delta);
      };
    }
    const server = Bun.serve<SocketData>({
      port: this.config.port,
      hostname: "0.0.0.0",
      // Blob uploads from the CLI go through the body limit below.
      maxRequestBodySize: MAX_DROP_BYTES + 1024,
      fetch: (request, srv) => {
        const path = new URL(request.url).pathname;
        if (path === WS_PATH) {
          if (srv.upgrade(request, { data: { session: null, connectedAt: Date.now(), vnc: null, canvas: null } }))
            return undefined;
          return new Response("websocket upgrade required", { status: 426 });
        }
        if (path === VNC_PATH) {
          const grant = authorizeVnc(request, this.vncTickets);
          if (grant instanceof Response) return grant;
          const upgraded = srv.upgrade(request, {
            data: { session: null, connectedAt: Date.now(), vnc: { deviceId: grant.deviceId, bridge: null }, canvas: null },
            ...(grant.protocol === null ? {} : { headers: { "Sec-WebSocket-Protocol": grant.protocol } }),
          });
          return upgraded ? undefined : new Response("websocket upgrade required", { status: 426 });
        }
        const canvasRoom = authorizeCanvasSocket(this.deps.canvas, request, path);
        if (canvasRoom instanceof Response) return canvasRoom;
        if (canvasRoom !== null) {
          const upgraded = srv.upgrade(request, { data: { session: null, connectedAt: Date.now(), vnc: null, canvas: { room: canvasRoom, peer: null } } });
          return upgraded ? undefined : new Response("websocket upgrade required", { status: 426 });
        }
        const remote = srv.requestIP(request)?.address ?? "";
        if (path === "/drops" || path.startsWith("/drops/"))
          return this.handleDropRequest(request, path, remote);
        if (path.startsWith("/artifacts/media/") && (request.method === "GET" || request.method === "HEAD")) {
          // `/artifacts/media/<sha>/<token>`: an image Isaac pasted into a thread, for anyone holding its token.
          const [, , , sha, token, ...rest] = path.split("/");
          const blob = sha === undefined || token === undefined || rest.length > 0 ? null : (this.deps.artifacts?.openMedia(sha, token) ?? null);
          return blob === null ? new Response("not found", { status: 404 }) : serveBlob(request, blob);
        }
        if (path === "/boards" || path.startsWith("/boards/"))
          return handleBoardRequest(this.deps.boards, request, path, remote);
        if (path === "/canvas" || path.startsWith("/canvas/"))
          return handleCanvasRequest(this.deps.canvas, this.deps.canvasPage, request, path, remote);
        if (path === "/assistant/say") return handleAssistantSay(this.deps.assistant, request, remote);
        if (path === "/catchup/bounce") return handleCatchUpBounce(this.deps.catchup, request, remote);
        if (path === "/reactions/agent") return handleAgentReaction(this.deps.reactions, this.deps.assistant, request, remote);
        return new Response("not found", { status: 404 });
      },
      websocket: {
        // The phone pings every 5 s; anything quieter than a minute is a dead peer.
        idleTimeout: 60,
        open: (ws) => {
          if (ws.data.vnc !== null) this.openVnc(ws, ws.data.vnc);
          else if (ws.data.canvas !== null) this.openCanvas(ws, ws.data.canvas);
          else this.accept(ws);
        },
        message: (ws, raw) => {
          const canvas = ws.data.canvas;
          if (canvas !== null) {
            // y-websocket: binary frames only.
            if (canvas.peer !== null && typeof raw !== "string") canvas.room.sync.receive(canvas.peer, new Uint8Array(raw));
            return;
          }
          const vnc = ws.data.vnc;
          if (vnc !== null) {
            // websockify `binary`: raw RFB bytes only.
            if (typeof raw === "string") vnc.bridge?.close(1003, "binary frames only");
            else vnc.bridge?.fromPeer(raw);
            return;
          }
          const session = ws.data.session;
          if (session === null) return;
          if (typeof raw !== "string") {
            session.receiveRaw("\u0000binary"); // fails as malformed json -> protocol error
            return;
          }
          session.receiveRaw(raw);
        },
        drain: (ws) => {
          ws.data.vnc?.bridge?.drain();
        },
        close: (ws) => {
          const canvas = ws.data.canvas;
          if (canvas !== null) {
            if (canvas.peer !== null) this.deps.canvas?.disconnect(canvas.room, canvas.peer);
            this.canvasSockets.delete(ws);
            return;
          }
          if (ws.data.vnc !== null) {
            ws.data.vnc.bridge?.peerClosed();
            this.vncSockets.delete(ws);
            return;
          }
          ws.data.session?.handleDisconnect();
          this.sockets.delete(ws);
        },
      },
    });
    this.server = server;
    // The port is the single-instance lock: claim the agent socket only after it binds, or a
    // second host that loses the port would first unlink the live host's socket.
    const agents = this.deps.agents;
    if (agents !== null) {
      agents.start();
      this.agentsTracker.seed(agents.sessions);
      this.deps.notifier?.seed(agents.sessions);
      agents.onChange = (change) => {
        this.handleProviderChange(change);
      };
    }
    return server.port ?? this.config.port;
  }

  stop(): void {
    for (const ws of this.sockets) ws.close();
    for (const ws of this.vncSockets) ws.close();
    for (const ws of this.canvasSockets) ws.close();
    this.sockets.clear();
    this.vncSockets.clear();
    this.canvasSockets.clear();
    void this.server?.stop(true);
    this.server = null;
  }

  get connectedDevices(): ConnectedDevice[] {
    const out: ConnectedDevice[] = [];
    for (const ws of this.sockets) {
      const session = ws.data.session;
      if (session === null || !session.isAuthenticated || session.deviceId === null) continue;
      out.push({
        deviceId: session.deviceId,
        deviceName: session.deviceName ?? "",
        connectedAt: ws.data.connectedAt,
      });
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
      if (session !== null && session.deviceId === deviceId && session.isSubscribed(sessionId))
        return true;
    }
    return false;
  }

  /** Whether the phone `deviceId` has agent `agent`'s thread open on some live connection. */
  isViewingAssistant(deviceId: string, agent: string): boolean {
    for (const ws of this.sockets) {
      const session = ws.data.session;
      if (session !== null && session.deviceId === deviceId && session.isFollowingAssistant(agent)) return true;
    }
    return false;
  }

  /** Sends `message` to every socket following agent `agent`'s thread. */
  broadcastAssistant(agent: string, message: ServerMessage): void {
    for (const ws of this.sockets) {
      if (ws.data.session?.isFollowingAssistant(agent) === true) ws.data.session.broadcast(message);
    }
  }

  /** Sends `message` to every authenticated device except `exceptDeviceId` (`null`: all of them). */
  broadcastExcept(message: ServerMessage, exceptDeviceId: string | null): void {
    for (const ws of this.sockets) {
      const session = ws.data.session;
      if (session !== null && session.deviceId !== exceptDeviceId) session.broadcast(message);
    }
  }

  /** Whether the escalation engine (EvaOS) is connected and authenticated. */
  escalatorConnected(): boolean {
    for (const ws of this.sockets) {
      const session = ws.data.session;
      if (session !== null && session.isAuthenticated && session.deviceId === ESCALATOR_DEVICE_ID) return true;
    }
    return false;
  }

  private handleProviderChange(change: AgentProviderChange): void {
    this.deps.assistant?.observe(change);
    this.deps.calls?.observe(change);
    this.deps.reactions?.observe(change);
    this.deps.artifacts?.observe(change);
    if (change.kind === "sessions") {
      const sessions = this.deps.agents?.sessions ?? [];
      const delta = this.agentsTracker.apply(sessions);
      for (const ws of this.sockets) ws.data.session?.broadcast(delta);
      this.deps.notifier?.observe(sessions);
      return;
    }
    if (change.kind === "message") {
      for (const ws of this.sockets) ws.data.session?.agentMessageUpdated(change.sessionId, change.id, change.text, change.streaming);
      return;
    }
    if (change.kind === "ask") {
      for (const ws of this.sockets) ws.data.session?.agentAsk(change.sessionId, change.ask);
      return;
    }
    if (change.kind === "ask.resolved") {
      this.deps.inbox?.settled("ask", change.id);
      for (const ws of this.sockets) ws.data.session?.agentAskResolved(change.sessionId, change.id);
      return;
    }
    if (change.kind === "approval") {
      for (const ws of this.sockets) ws.data.session?.agentApproval(change.sessionId, change.approval);
      return;
    }
    if (change.kind === "approval.resolved") {
      // Before the frame below, so EvaOS hears "phone" ahead of the plain resolve it reacts to.
      this.deps.inbox?.settled("approval", change.id);
      for (const ws of this.sockets) ws.data.session?.agentApprovalResolved(change.sessionId, change.id);
      return;
    }
    if (change.kind === "gate") {
      const message: ServerMessage = { t: "gate.status", gate: this.deps.agents?.gate ?? null };
      for (const ws of this.sockets) ws.data.session?.broadcast(message);
      return;
    }
    for (const ws of this.sockets)
      ws.data.session?.agentConversationAppended(change.sessionId, change.appended);
  }

  private handleDropChange(change: DropChange): void {
    const message: ServerMessage =
      change.kind === "added"
        ? { t: "drop.new", drop: change.drop }
        : { t: "drop.removed", id: change.id };
    for (const ws of this.sockets) ws.data.session?.broadcast(message);
  }

  /**
   * `GET`/`HEAD /drops/<id>/<token>` serves a blob, with byte ranges, to anyone holding the token
   * (it only ever travels to authenticated phones); `/drops/<id>/<token>/poster` is a video drop's
   * poster JPEG. `POST /drops` adds a drop and is loopback-only: it is how `relay share` on this
   * machine reaches the running daemon. Text body with `content-type: text/plain` makes a
   * text/link drop; any other body is a blob named by `x-drop-name` (a video by type or extension,
   * probed for its poster; 413 over the video cap).
   */
  private async handleDropRequest(
    request: Request,
    path: string,
    remote: string,
  ): Promise<Response> {
    const drops = this.deps.drops;
    if (drops === null) return new Response("drops disabled", { status: 404 });
    if (request.method === "GET" || request.method === "HEAD") {
      const [, , id, token, part, ...rest] = path.split("/");
      if (id === undefined || token === undefined || token === "" || rest.length > 0)
        return new Response("not found", { status: 404 });
      const blob =
        part === undefined ? drops.open(id, token) : part === "poster" ? drops.openPoster(id, token) : null;
      if (blob === null) return new Response("not found", { status: 404 });
      return serveBlob(request, blob);
    }
    if (request.method === "POST" && path === "/drops") {
      if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
      const type = request.headers.get("content-type") ?? "application/octet-stream";
      try {
        if (type.startsWith("text/plain")) {
          const text = await request.text();
          if (text.trim() === "") return new Response("empty text", { status: 400 });
          return Response.json(drops.putText("host", text));
        }
        const name = basename(request.headers.get("x-drop-name") ?? "") || "file";
        const mimeType = videoMimeOf(name, type.split(";")[0] ?? type);
        const bytes = new Uint8Array(await request.arrayBuffer());
        return Response.json(
          isVideoMime(mimeType)
            ? await drops.putVideo("host", { name, mimeType, bytes })
            : drops.putBlob("host", { name, mimeType, bytes }),
        );
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), {
          status: error instanceof VideoTooLarge ? 413 : 400,
        });
      }
    }
    return new Response("method not allowed", { status: 405 });
  }

  /** A token holder opened a canvas room's websocket: it becomes a peer of the room's doc. */
  private openCanvas(ws: Socket, canvas: { readonly room: CanvasRoom; peer: CanvasPeer | null }): void {
    const peer: CanvasPeer = {
      send: (data) => {
        ws.sendBinary(data);
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
    };
    canvas.peer = peer;
    this.canvasSockets.add(ws);
    this.deps.canvas?.connect(canvas.room, peer);
  }

  /** A ticket-holding device opened `VNC_PATH`: connect it to the Mac's VNC server. */
  private openVnc(ws: Socket, vnc: { readonly deviceId: string; bridge: VncBridge | null }): void {
    vnc.bridge = new VncBridge(
      {
        send: (data) => ws.send(data),
        close: (code, reason) => {
          ws.close(code, reason);
        },
      },
      this.vncTickets.port,
      this.deps.log,
    );
    this.vncSockets.add(ws);
    this.deps.log(`live view (vnc) for ${vnc.deviceId} from ${ws.remoteAddress}`);
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
        images: this.deps.images,
        agents: this.deps.agents,
        agentsTracker: this.agentsTracker,
        devices: this.deps.devices,
        push: this.deps.push,
        drops: this.deps.drops,
        boards: this.deps.boards,
        pairing: this.pairing,
        remoteAddress: ws.remoteAddress,
        dedup: this.dedup,
        vnc: this.vncTickets,
        inbox: this.deps.inbox,
        assistant: this.deps.assistant,
        calls: this.deps.calls,
        usage: this.deps.usage,
        catchup: this.deps.catchup,
        reactions: this.deps.reactions,
        artifacts: this.deps.artifacts,
        canvas: this.deps.canvas,
      },
      (closed) => {
        const reason = closed.closeReason;
        this.deps.log(
          `disconnected ${closed.deviceName ?? ws.remoteAddress}${reason === null ? "" : ` (${reason})`}`,
        );
      },
    );
    ws.data.session = session;
    this.sockets.add(ws);
    this.deps.log(`connection from ${ws.remoteAddress}`);
  }
}
