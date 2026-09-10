import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ClientMessage, type InputEvent, type KeyName, type ServerMessage } from "@relay/protocol";
import { CommandDedupStore } from "../src/dedup";
import { PairingCoordinator } from "../src/pairing";
import { AckFailure, type DeviceStore, type FrameSink, type InputSink, type PairedDevice, type PairingUI, type TextInjecting } from "../src/seams";
import { ClientSession, PAIRING_TIMEOUT_MS, type SessionClock, type SessionDeps } from "../src/session";

class RecordingSink implements FrameSink {
  readonly sent: ServerMessage[] = [];
  closed = false;
  private waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  send(message: ServerMessage): void {
    if (this.closed) return;
    this.sent.push(message);
    const ready = this.waiters.filter((waiter) => this.sent.length >= waiter.count);
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) waiter.resolve();
  }
  close(): void {
    this.closed = true;
  }
  last(): ServerMessage {
    const message = this.sent.at(-1);
    if (message === undefined) throw new Error("nothing sent");
    return message;
  }
  /** Resolves once `count` frames have been sent in total; the real signal async commands emit. */
  sentCount(count: number): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push({ count, resolve });
    return promise;
  }
}

class MemoryDevices implements DeviceStore {
  secrets: Record<string, Uint8Array> = {};
  secret(deviceId: string): Uint8Array | null {
    return this.secrets[deviceId] ?? null;
  }
  save(secret: Uint8Array, deviceId: string): void {
    this.secrets[deviceId] = secret;
  }
  forget(deviceId: string): void {
    this.secrets = Object.fromEntries(Object.entries(this.secrets).filter(([id]) => id !== deviceId));
  }
  pairedDevices(): PairedDevice[] {
    return [];
  }
}

class FakeClock implements SessionClock {
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  private current = 1_000;
  now(): number {
    return this.current;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.current);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
  }
}

interface Harness {
  readonly sink: RecordingSink;
  readonly session: ClientSession;
  readonly devices: MemoryDevices;
  readonly clock: FakeClock;
  readonly pins: string[];
  readonly typed: string[];
  readonly pressed: KeyName[];
  readonly input: InputEvent[][];
  readonly closed: ClientSession[];
}

function harness(options: { granted?: boolean; devices?: MemoryDevices; dedup?: CommandDedupStore; failText?: boolean } = {}): Harness {
  const pins: string[] = [];
  const typed: string[] = [];
  const pressed: KeyName[] = [];
  const input: InputEvent[][] = [];
  const closed: ClientSession[] = [];
  const devices = options.devices ?? new MemoryDevices();
  const ui: PairingUI = {
    beginPairing: (_name, pin) => pins.push(pin),
    endPairing: () => undefined,
  };
  const text: TextInjecting = {
    insert: (value) => {
      if (options.failText === true) return Promise.reject(new AckFailure({ code: "invalid_command", message: "nope" }));
      typed.push(value);
      return Promise.resolve();
    },
    press: (key) => {
      pressed.push(key);
      return Promise.resolve();
    },
  };
  const inputSink: InputSink = { handle: (events) => input.push([...events]) };
  const deps: SessionDeps = {
    hostName: "omarchy",
    version: "0.1.0",
    input: inputSink,
    text,
    access: { granted: options.granted ?? true },
    devices,
    pairing: new PairingCoordinator(ui),
    dedup: options.dedup ?? new CommandDedupStore(),
  };
  const sink = new RecordingSink();
  const clock = new FakeClock();
  const session = new ClientSession(sink, deps, (s) => closed.push(s), clock);
  return { sink, session, devices, clock, pins, typed, pressed, input, closed };
}

const hello: ClientMessage = { t: "hello", v: 1, deviceId: "phone-1", deviceName: "Isaac's iPhone", platform: "ios" };

function pair(h: Harness): string {
  h.session.receive(hello);
  expect(h.sink.last()).toEqual({ t: "unpaired" });
  h.session.receive({ t: "pair.request" });
  expect(h.sink.last()).toEqual({ t: "pair.pending" });
  const pin = h.pins[0];
  if (pin === undefined) throw new Error("no pin shown");
  h.session.receive({ t: "pair.confirm", pin });
  const ok = h.sink.sent.find((m) => m.t === "pair.ok");
  if (ok?.t !== "pair.ok") throw new Error("expected pair.ok");
  return ok.secret;
}

describe("pairing", () => {
  it("issues a 32-byte secret, stores it, and welcomes with the host snapshot", () => {
    const h = harness();
    const secret = pair(h);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(h.devices.secret("phone-1")).not.toBeNull();
    expect(h.sink.last()).toEqual({
      t: "welcome",
      state: {
        mac: { name: "omarchy", version: "0.1.0", accessibilityGranted: true, agentsAvailable: false },
        agents: { rev: 0, sessions: [] },
      },
    });
    expect(h.session.isAuthenticated).toBe(true);
  });

  it("closes after three wrong PINs without storing a secret", () => {
    const h = harness();
    h.session.receive(hello);
    h.session.receive({ t: "pair.request" });
    h.session.receive({ t: "pair.confirm", pin: "000000" });
    expect(h.sink.last()).toEqual({ t: "pair.failed", reason: "wrong_pin" });
    h.session.receive({ t: "pair.confirm", pin: "000001" });
    h.session.receive({ t: "pair.confirm", pin: "000002" });
    expect(h.sink.last()).toEqual({ t: "pair.failed", reason: "too_many_attempts" });
    expect(h.sink.closed).toBe(true);
    expect(h.devices.secret("phone-1")).toBeNull();
    expect(h.closed).toHaveLength(1);
  });

  it("times out after 120 s and frees the pairing slot for the next phone", () => {
    const h = harness();
    h.session.receive(hello);
    h.session.receive({ t: "pair.request" });
    h.clock.advance(PAIRING_TIMEOUT_MS);
    expect(h.sink.last()).toEqual({ t: "pair.failed", reason: "timeout" });
    expect(h.sink.closed).toBe(true);
    // A second session on the same coordinator can now pair.
    const second = harness({ devices: h.devices });
    second.session.receive({ ...hello, deviceId: "phone-2" });
    second.session.receive({ t: "pair.request" });
    expect(second.sink.last()).toEqual({ t: "pair.pending" });
  });
});

describe("reconnect auth", () => {
  it("accepts a valid HMAC-SHA256 proof over the nonce and rejects a wrong one", () => {
    const first = harness();
    const secret = pair(first);

    const good = harness({ devices: first.devices });
    good.session.receive(hello);
    const challenge = good.sink.last();
    if (challenge.t !== "challenge") throw new Error("expected challenge");
    const proof = createHmac("sha256", Buffer.from(secret, "hex")).update(challenge.nonce).digest("hex");
    good.session.receive({ t: "auth", proof });
    expect(good.sink.last().t).toBe("welcome");

    const bad = harness({ devices: first.devices });
    bad.session.receive(hello);
    bad.session.receive({ t: "auth", proof: "ab".repeat(32) });
    expect(bad.sink.last()).toMatchObject({ t: "error", code: "auth_failed" });
    expect(bad.sink.closed).toBe(true);
  });

  it("rejects a hello for a forgotten device with unpaired, not an auth error", () => {
    const h = harness();
    h.session.receive(hello);
    expect(h.sink.last()).toEqual({ t: "unpaired" });
  });
});

describe("authenticated traffic", () => {
  it("forwards input only while the virtual device is available", () => {
    const h = harness();
    pair(h);
    h.session.receive({ t: "input", events: [{ k: "move", dx: 1, dy: 2, t: 10 }] });
    expect(h.input).toHaveLength(1);

    const denied = harness({ granted: false });
    pair(denied);
    denied.session.receive({ t: "input", events: [{ k: "move", dx: 1, dy: 2, t: 10 }] });
    expect(denied.input).toHaveLength(0);
  });

  it("acks text and key commands, nacks when input is unavailable or the injector fails", async () => {
    const h = harness();
    pair(h);
    h.session.receive({ t: "cmd", id: "c1", cmd: { kind: "text.insert", text: "hi" } });
    h.session.receive({ t: "cmd", id: "c2", cmd: { kind: "key.press", key: "return" } });
    await h.sink.sentCount(6); // 4 pairing frames + 2 acks
    expect(h.typed).toEqual(["hi"]);
    expect(h.pressed).toEqual(["return"]);
    expect(h.sink.sent.flatMap((m) => (m.t === "ack" ? [m.id] : []))).toEqual(["c1", "c2"]);

    const denied = harness({ granted: false });
    pair(denied);
    denied.session.receive({ t: "cmd", id: "c3", cmd: { kind: "key.press", key: "tab" } });
    await denied.sink.sentCount(5);
    expect(denied.sink.last()).toMatchObject({ t: "nack", id: "c3", error: { code: "accessibility_denied" } });

    const failing = harness({ failText: true });
    pair(failing);
    failing.session.receive({ t: "cmd", id: "c4", cmd: { kind: "text.insert", text: "x" } });
    await failing.sink.sentCount(5);
    expect(failing.sink.last()).toMatchObject({ t: "nack", id: "c4", error: { code: "invalid_command", message: "nope" } });
  });

  it("replays the original response for a retried command id across reconnects", async () => {
    const dedup = new CommandDedupStore();
    const first = harness({ dedup });
    const secret = pair(first);
    first.session.receive({ t: "cmd", id: "same", cmd: { kind: "text.insert", text: "once" } });
    await first.sink.sentCount(5);
    expect(first.typed).toEqual(["once"]);

    const second = harness({ dedup, devices: first.devices });
    second.session.receive(hello);
    const challenge = second.sink.last();
    if (challenge.t !== "challenge") throw new Error("expected challenge");
    second.session.receive({ t: "auth", proof: createHmac("sha256", Buffer.from(secret, "hex")).update(challenge.nonce).digest("hex") });
    second.session.receive({ t: "cmd", id: "same", cmd: { kind: "text.insert", text: "once" } });
    await second.sink.sentCount(3); // challenge, welcome, replayed ack
    expect(second.typed).toEqual([]);
    expect(second.sink.last()).toEqual({ t: "ack", id: "same" });
  });

  it("nacks agent.reply because Linux v1 has no agent provider", async () => {
    const h = harness();
    pair(h);
    h.session.receive({ t: "cmd", id: "a1", cmd: { kind: "agent.reply", sessionId: "s", text: "go" } });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toMatchObject({ t: "nack", id: "a1", error: { code: "agent_cannot_respond" } });
  });

  it("answers ping with the server clock and rejects a second hello", () => {
    const h = harness();
    pair(h);
    h.session.receive({ t: "ping", ts: 42 });
    expect(h.sink.last()).toEqual({ t: "pong", ts: 42, serverTs: 1000 });
    h.session.receive(hello);
    expect(h.sink.last()).toMatchObject({ t: "error", code: "protocol" });
    expect(h.sink.closed).toBe(true);
  });
});
