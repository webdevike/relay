// Live view: the phone runs noVNC against the Mac's built-in Screen Sharing (a VNC server on
// 127.0.0.1:5900), through this host. Port 5900 never faces the network: a paired, authenticated
// session asks for a ticket over its relay socket (`vnc.open`), and the ticket opens exactly one
// binary WebSocket at VNC_PATH whose bytes are piped to and from that TCP port (websockify
// semantics, subprotocol `binary`). Screen Sharing then asks for its own credential on top.

import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { VNC_SUBPROTOCOL, VNC_TICKET_TTL_MS } from "@relay/protocol";
import type { VncAccess } from "./seams";

export const VNC_HOST = "127.0.0.1";
/** macOS Screen Sharing's port. */
export const DEFAULT_VNC_PORT = 5900;
const PROBE_TIMEOUT_MS = 1_000;

/** Whether something accepts TCP connections on VNC_HOST:`port`. */
export function probeVnc(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host: VNC_HOST, port });
  const done = (reachable: boolean): void => {
    clearTimeout(timer);
    socket.destroy();
    resolve(reachable);
  };
  const timer = setTimeout(() => {
    done(false);
  }, timeoutMs);
  socket.once("connect", () => {
    done(true);
  });
  socket.once("error", () => {
    done(false);
  });
  return promise;
}

interface Ticket {
  readonly deviceId: string;
  readonly expiresAt: number;
}

/** One-time tickets for VNC_PATH, issued only to authenticated sessions and only while VNC is up. */
export class VncTickets implements VncAccess {
  private readonly tickets = new Map<string, Ticket>();

  constructor(
    readonly port: number,
    private readonly now: () => number = Date.now,
    private readonly probe: (port: number) => Promise<boolean> = probeVnc,
  ) {}

  async open(deviceId: string): Promise<string | null> {
    if (!(await this.probe(this.port))) return null;
    this.prune();
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, { deviceId, expiresAt: this.now() + VNC_TICKET_TTL_MS });
    return ticket;
  }

  /** Spends `ticket`: the device it was issued to, or null when it is unknown, spent or expired. */
  redeem(ticket: string): string | null {
    const entry = this.tickets.get(ticket);
    if (entry === undefined) return null;
    this.tickets.delete(ticket);
    return entry.expiresAt >= this.now() ? entry.deviceId : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(ticket);
  }
}

/** What an accepted request to VNC_PATH may open: the device's bridge, echoing `protocol` if offered. */
export interface VncGrant {
  readonly deviceId: string;
  readonly protocol: string | null;
}

/**
 * The gate in front of VNC_PATH: a WebSocket upgrade carrying a live ticket (`?ticket=`) is
 * granted; anything else gets the refusal to send back. A client that names subprotocols must
 * offer `binary`, the only one bridged (raw RFB bytes, no base64).
 */
export function authorizeVnc(request: Request, tickets: VncTickets): VncGrant | Response {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("websocket upgrade required", { status: 426 });
  const offered = request.headers.get("sec-websocket-protocol");
  const protocols = offered === null ? [] : offered.split(",").map((name) => name.trim());
  if (protocols.length > 0 && !protocols.includes(VNC_SUBPROTOCOL))
    return new Response(`subprotocol ${VNC_SUBPROTOCOL} required`, { status: 400 });
  const ticket = new URL(request.url).searchParams.get("ticket");
  const deviceId = ticket === null || ticket === "" ? null : tickets.redeem(ticket);
  if (deviceId === null) return new Response("unauthorized", { status: 401 });
  return { deviceId, protocol: protocols.length > 0 ? VNC_SUBPROTOCOL : null };
}

/** The WebSocket end of a bridge; Bun's `ServerWebSocket` in the server. */
export interface VncPeer {
  /** Bun semantics: -1 queued behind backpressure, 0 dropped (closed), otherwise bytes sent. */
  send(data: Uint8Array): number;
  close(code?: number, reason?: string): void;
}

/**
 * Pipes one WebSocket to a fresh TCP connection to the VNC server. Phone bytes that arrive before
 * the TCP connect finishes are held and written in order; server bytes pause while the WebSocket
 * is backed up and resume on `drain`. Either side ending closes the other.
 */
export class VncBridge {
  private readonly tcp: Socket;
  private connected = false;
  private pending: Uint8Array[] = [];
  private closed = false;

  constructor(
    private readonly peer: VncPeer,
    port: number,
    private readonly log: (line: string) => void,
  ) {
    this.tcp = connect({ host: VNC_HOST, port });
    this.tcp.setNoDelay(true);
    this.tcp.on("connect", () => {
      this.connected = true;
      for (const chunk of this.pending) this.tcp.write(chunk);
      this.pending = [];
    });
    this.tcp.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      const sent = this.peer.send(chunk);
      if (sent === -1) this.tcp.pause();
      else if (sent === 0) this.close(1000, "peer gone");
    });
    this.tcp.on("error", (error) => {
      this.log(`vnc: ${error.message}`);
      this.close(1011, "vnc server unreachable");
    });
    this.tcp.on("close", () => {
      this.close(1000, "vnc server closed");
    });
  }

  /** Bytes from the phone, in order. */
  fromPeer(data: Uint8Array): void {
    if (this.closed) return;
    if (this.connected) this.tcp.write(data);
    else this.pending.push(Uint8Array.from(data));
  }

  /** The WebSocket flushed its backlog: read from the VNC server again. */
  drain(): void {
    if (!this.closed) this.tcp.resume();
  }

  /** The phone hung up; ends the TCP side. */
  peerClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.tcp.destroy();
  }

  /** Ends both sides; idempotent. */
  close(code: number, reason: string): void {
    if (this.closed) return;
    this.peerClosed();
    this.peer.close(code, reason);
  }
}
