import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelaySocket } from "./socket";

class FakeWebSocket {
  static readonly OPEN = 1;
  static made: FakeWebSocket[] = [];
  readyState = 0;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this);
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  /** The peer or the network ends it. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const saved = globalThis.WebSocket;
let closes: [number, boolean][] = [];
let socket: RelaySocket;

beforeEach(() => {
  FakeWebSocket.made = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  closes = [];
  socket = new RelaySocket();
  socket.onClose = (epoch, local) => closes.push([epoch, local]);
});

afterEach(() => {
  globalThis.WebSocket = saved;
});

describe("RelaySocket epochs", () => {
  it("numbers each opened socket", () => {
    expect(socket.epoch).toBe(0);
    socket.open("ws://a");
    expect(socket.epoch).toBe(1);
    socket.open("ws://b");
    expect(socket.epoch).toBe(2);
  });

  it("open() while open reports the old epoch closed locally, before the new one can say anything", () => {
    socket.open("ws://a");
    socket.open("ws://b");
    expect(closes).toEqual([[1, true]]);
    expect(FakeWebSocket.made[0]?.closed).toBe(true);
    // The old socket's late events never reach the driver.
    expect(FakeWebSocket.made[0]?.onclose).toBeNull();
    expect(FakeWebSocket.made[0]?.onmessage).toBeNull();
  });

  it("close() reports once and is idempotent", () => {
    socket.open("ws://a");
    socket.close();
    socket.close();
    expect(closes).toEqual([[1, true]]);
  });

  it("a remote close reports its epoch once, not local, and a later close() adds nothing", () => {
    socket.open("ws://a");
    FakeWebSocket.made[0]?.drop();
    socket.close();
    socket.open("ws://b");
    expect(closes).toEqual([[1, false]]);
    expect(socket.epoch).toBe(2);
  });

  it("a socket that never opened (refused) still ends its epoch", () => {
    socket.open("ws://a");
    FakeWebSocket.made[0]?.drop();
    expect(closes).toEqual([[1, false]]);
    expect(socket.isOpen).toBe(false);
  });

  it("send is a no-op unless the socket is open", () => {
    socket.open("ws://a");
    expect(socket.send("x")).toBe(false);
    const ws = FakeWebSocket.made[0];
    if (ws === undefined) throw new Error("no socket");
    ws.readyState = FakeWebSocket.OPEN;
    expect(socket.send("y")).toBe(true);
    expect(ws.sent).toEqual(["y"]);
  });
});
