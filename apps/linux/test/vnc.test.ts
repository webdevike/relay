import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { VNC_TICKET_TTL_MS } from "@relay/protocol";
import { authorizeVnc, probeVnc, VncBridge, VncTickets, type VncGrant, type VncPeer } from "../src/vnc";

/** Wakes waiters whenever the thing it watches changes; `until` re-checks on every wake. */
class Changes {
  private waiters: (() => void)[] = [];
  notify(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
  async until(check: () => boolean): Promise<void> {
    while (!check()) {
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.push(resolve);
      await promise;
    }
  }
}

/** A stand-in Screen Sharing: greets like an RFB server and records what each client sends. */
class FakeVncServer {
  readonly received: Buffer[] = [];
  readonly clients: Socket[] = [];
  readonly changes = new Changes();
  private readonly server: Server;
  port = 0;

  constructor() {
    this.server = createServer((socket) => {
      this.clients.push(socket);
      // The reachability probe connects and resets at once.
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => {
        this.received.push(chunk);
        this.changes.notify();
      });
      socket.write("RFB 003.008\n");
      this.changes.notify();
    });
  }

  async start(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.listen(0, "127.0.0.1", resolve);
    await promise;
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    this.port = address.port;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.destroy();
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => {
      resolve();
    });
    await promise;
  }
}

class RecordingPeer implements VncPeer {
  readonly sent: Buffer[] = [];
  readonly changes = new Changes();
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  send(data: Uint8Array): number {
    this.sent.push(Buffer.from(data));
    this.changes.notify();
    return data.byteLength;
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.changes.notify();
  }
}

function upgrade(query: string, protocol?: string): Request {
  const headers: Record<string, string> = { upgrade: "websocket", connection: "Upgrade" };
  if (protocol !== undefined) headers["sec-websocket-protocol"] = protocol;
  return new Request(`http://127.0.0.1:7817/vnc${query}`, { headers });
}

function statusOf(result: VncGrant | Response): number | VncGrant {
  return result instanceof Response ? result.status : result;
}

const servers: FakeVncServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function fakeVnc(): Promise<FakeVncServer> {
  const server = new FakeVncServer();
  servers.push(server);
  await server.start();
  return server;
}

/** A port that just had a listener and now has none. */
async function closedPort(): Promise<number> {
  const server = new FakeVncServer();
  await server.start();
  await server.stop();
  return server.port;
}

describe("vnc gate", () => {
  const up = (): Promise<boolean> => Promise.resolve(true);

  it("refuses requests without a live ticket", async () => {
    const tickets = new VncTickets(5900, Date.now, up);
    expect(statusOf(authorizeVnc(new Request("http://127.0.0.1:7817/vnc"), tickets))).toBe(426);
    expect(statusOf(authorizeVnc(upgrade(""), tickets))).toBe(401);
    expect(statusOf(authorizeVnc(upgrade("?ticket="), tickets))).toBe(401);
    expect(statusOf(authorizeVnc(upgrade("?ticket=forged"), tickets))).toBe(401);
    const ticket = await tickets.open("phone-1");
    if (ticket === null) throw new Error("expected a ticket");
    expect(statusOf(authorizeVnc(upgrade(`?ticket=${ticket}`, "base64"), tickets))).toBe(400);
  });

  it("grants a ticket once, to the device it was issued for, echoing the binary subprotocol", async () => {
    const tickets = new VncTickets(5900, Date.now, up);
    const ticket = await tickets.open("phone-1");
    if (ticket === null) throw new Error("expected a ticket");
    expect(authorizeVnc(upgrade(`?ticket=${ticket}`, "binary"), tickets)).toEqual({ deviceId: "phone-1", protocol: "binary" });
    expect(statusOf(authorizeVnc(upgrade(`?ticket=${ticket}`, "binary"), tickets))).toBe(401);

    const bare = await tickets.open("phone-2");
    if (bare === null) throw new Error("expected a ticket");
    expect(authorizeVnc(upgrade(`?ticket=${bare}`), tickets)).toEqual({ deviceId: "phone-2", protocol: null });
  });

  it("expires tickets", async () => {
    let now = 1_000;
    const tickets = new VncTickets(5900, () => now, up);
    const ticket = await tickets.open("phone-1");
    if (ticket === null) throw new Error("expected a ticket");
    now += VNC_TICKET_TTL_MS + 1;
    expect(statusOf(authorizeVnc(upgrade(`?ticket=${ticket}`), tickets))).toBe(401);
  });

  it("issues no ticket while nothing listens on the VNC port", async () => {
    const port = await closedPort();
    expect(await probeVnc(port)).toBe(false);
    expect(await new VncTickets(port).open("phone-1")).toBeNull();
  });
});

describe("vnc bridge", () => {
  it("bridges an authorized socket to the VNC server, both ways and in order", async () => {
    const server = await fakeVnc();
    const tickets = new VncTickets(server.port);
    const ticket = await tickets.open("phone-1");
    if (ticket === null) throw new Error("Screen Sharing stand-in should be reachable");
    expect(authorizeVnc(upgrade(`?ticket=${ticket}`, "binary"), tickets)).toEqual({ deviceId: "phone-1", protocol: "binary" });

    const peer = new RecordingPeer();
    const bridge = new VncBridge(peer, tickets.port, () => undefined);
    // Sent before the TCP connect completes: held, then written in order.
    bridge.fromPeer(Buffer.from("RFB 003.008\n"));
    bridge.fromPeer(Uint8Array.of(1));
    await peer.changes.until(() => Buffer.concat(peer.sent).toString("latin1") === "RFB 003.008\n");
    await server.changes.until(() => Buffer.concat(server.received).toString("latin1") === "RFB 003.008\n\u0001");

    // The server hanging up closes the WebSocket (the first connection was the reachability probe).
    server.clients.at(-1)?.end();
    await peer.changes.until(() => peer.closedWith !== null);
    expect(peer.closedWith).toEqual({ code: 1000, reason: "vnc server closed" });
  });

  it("closes the TCP side when the phone hangs up", async () => {
    const server = await fakeVnc();
    const peer = new RecordingPeer();
    const bridge = new VncBridge(peer, server.port, () => undefined);
    await server.changes.until(() => server.clients.length === 1);
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
    const ended = Promise.withResolvers<void>();
    server.clients[0]?.on("close", () => {
      ended.resolve();
    });
    bridge.peerClosed();
    await ended.promise;
    bridge.fromPeer(Uint8Array.of(9));
    expect(server.received).toEqual([]);
    expect(peer.closedWith).toBeNull();
  });

  it("closes the WebSocket when the VNC server is unreachable", async () => {
    const port = await closedPort();
    const peer = new RecordingPeer();
    const lines: string[] = [];
    new VncBridge(peer, port, (line) => lines.push(line));
    await peer.changes.until(() => peer.closedWith !== null);
    expect(peer.closedWith).toEqual({ code: 1011, reason: "vnc server unreachable" });
    expect(lines[0]).toMatch(/^vnc: /);
  });
});
