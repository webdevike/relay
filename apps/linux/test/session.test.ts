import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultTabs, type AgentApproval, type AgentAsk, type AgentAskAnswer, type AgentImage, type AgentMessage, type AgentOptions, type AgentSession, type ApprovalConfirmation, type AssistantAgent, type AssistantSnapshot, type ClientMessage, type GateStatus, type InboxItem, type InputEvent, type KeyName, type ServerMessage } from "@relay/protocol";
import { AgentsDeltaTracker } from "../src/agents/delta-tracker";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBoardStore } from "../src/boards/store";
import { CommandDedupStore } from "../src/dedup";
import { PairingCoordinator } from "../src/pairing";
import type { UsageService } from "../src/usage/service";
import type { CatchUpDeck } from "../src/catchup/service";
import type { ReactionRelaying } from "../src/reactions/service";
import type { ArtifactRelaying } from "../src/artifacts/service";
import { AckFailure, type AgentConfigChange, type AgentProvider, type AssistantRelaying, type AssistantThread, type CallClientMessage, type CallRelaying, type DeviceStore, type DropBox, type FrameSink, type GateCommand, type InboxRelaying, type InputSink, type PairedDevice, type PairingUI, type PushRegistry, type TextInjecting, type VncAccess } from "../src/seams";
import { ASSISTANT_FOLLOW_MS, ClientSession, PAIRING_TIMEOUT_MS, type SessionClock, type SessionDeps } from "../src/session";

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

interface HarnessOptions {
  granted?: boolean;
  remoteAddress?: string;
  devices?: MemoryDevices;
  dedup?: CommandDedupStore;
  failText?: boolean;
  agents?: AgentProvider;
  tracker?: AgentsDeltaTracker;
  push?: PushRegistry;
  drops?: DropBox;
  boards?: FileBoardStore;
  vnc?: VncAccess;
  inbox?: InboxRelaying;
  assistant?: AssistantRelaying;
  calls?: CallRelaying;
  usage?: UsageService;
  catchup?: CatchUpDeck;
  reactions?: ReactionRelaying;
  artifacts?: ArtifactRelaying;
}

function harness(options: HarnessOptions = {}): Harness {
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
    images: { paste: () => Promise.resolve() },
    agents: options.agents ?? null,
    agentsTracker: options.tracker ?? new AgentsDeltaTracker(),
    devices,
    push: options.push ?? null,
    drops: options.drops ?? null,
    boards: options.boards ?? null,
    pairing: new PairingCoordinator(ui),
    remoteAddress: options.remoteAddress ?? "192.168.1.20",
    dedup: options.dedup ?? new CommandDedupStore(),
    vnc: options.vnc ?? { open: () => Promise.resolve(null) },
    inbox: options.inbox ?? null,
    assistant: options.assistant ?? null,
    calls: options.calls ?? null,
    usage: options.usage ?? null,
    catchup: options.catchup ?? null,
    reactions: options.reactions ?? null,
    artifacts: options.artifacts ?? null,
  };
  const sink = new RecordingSink();
  const clock = new FakeClock();
  const session = new ClientSession(sink, deps, (s) => closed.push(s), clock);
  return { sink, session, devices, clock, pins, typed, pressed, input, closed };
}

const hello: ClientMessage = { t: "hello", v: 1, deviceId: "phone-1", deviceName: "Isaac's iPhone", platform: "ios" };

function pair(h: Harness, deviceId = "phone-1"): string {
  h.session.receive({ t: "hello", v: 1, deviceId, deviceName: "Isaac's iPhone", platform: "ios" });
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

  it("pairs a tailnet peer without a PIN and rejects look-alike LAN addresses", () => {
    const h = harness({ remoteAddress: "::ffff:100.79.119.8" });
    h.session.receive(hello);
    h.session.receive({ t: "pair.request" });
    expect(h.pins).toEqual([]);
    expect(h.sink.sent.some((m) => m.t === "pair.ok")).toBe(true);
    const lan = harness({ remoteAddress: "100.128.0.1" });
    lan.session.receive(hello);
    lan.session.receive({ t: "pair.request" });
    expect(lan.sink.last()).toEqual({ t: "pair.pending" });
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
    h.session.receive({ t: "cmd", id: "a1", cmd: { kind: "agent.reply", sessionId: "s", text: "go", submit: true } });
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

  it("binds push.register / push.unregister to the authenticated device and never before auth", () => {
    const calls: string[] = [];
    const push: PushRegistry = {
      register: (deviceId, token) => calls.push(`+${deviceId}:${token}`),
      unregister: (deviceId) => calls.push(`-${deviceId}`),
    };
    const h = harness({ push });
    h.session.receive(hello);
    h.session.receive({ t: "push.register", token: "ExponentPushToken[x]" });
    expect(h.sink.closed).toBe(true);
    expect(calls).toEqual([]);
    const paired = harness({ push, devices: h.devices });
    pair(paired);
    paired.session.receive({ t: "push.register", token: "ExponentPushToken[x]" });
    paired.session.receive({ t: "push.unregister" });
    expect(calls).toEqual(["+phone-1:ExponentPushToken[x]", "-phone-1"]);
  });
});

class FakeProvider implements AgentProvider {
  readonly id = "omp";
  isAvailable = true;
  onChange: AgentProvider["onChange"] = null;
  readonly replies: [string, string, boolean, readonly AgentImage[] | undefined][] = [];
  started = false;
  sessions: AgentSession[] = [
    { id: "s1", provider: "omp", title: "relay", projectPath: "/w/relay", status: "idle", lastActivity: "done", lastActivityAt: 5, canRespond: true },
  ];
  start(): void {
    this.started = true;
  }
  conversation(sessionId: string): Promise<AgentMessage[] | null> {
    return Promise.resolve(sessionId === "s1" ? [{ id: "m1", role: "user", text: "hi", at: 1 }] : null);
  }
  reply(sessionId: string, text: string, submit: boolean, images?: readonly AgentImage[]): Promise<void> {
    if (sessionId !== "s1") return Promise.reject(new AckFailure({ code: "agent_not_found", message: "gone" }));
    this.replies.push([sessionId, text, submit, images]);
    return Promise.resolve();
  }
  readonly notes: [string, string][] = [];
  note(sessionId: string, text: string): Promise<boolean> {
    this.notes.push([sessionId, text]);
    return Promise.resolve(sessionId === "s1");
  }
  image(sessionId: string, id: string): Promise<AgentImage | null> {
    return Promise.resolve(sessionId === "s1" && id === "img1" ? { mimeType: "image/png", data: "iVBOR" } : null);
  }
  readonly launched: [string | undefined, string | undefined, "personal" | "work" | undefined][] = [];
  launch(prompt?: string, thinkingLevel?: string, profile?: "personal" | "work"): Promise<void> {
    this.launched.push([prompt, thinkingLevel, profile]);
    return Promise.resolve();
  }
  options(sessionId: string): Promise<AgentOptions | null> {
    return Promise.resolve(
      sessionId === "s1"
        ? {
            models: [{ provider: "anthropic", id: "m", name: "M", vendor: "anthropic", thinkingLevels: ["off", "low"] }],
            skills: [{ name: "deploy", description: "Ship it", command: "/skill:deploy", takesText: true }],
          }
        : null,
    );
  }
  readonly configured: AgentConfigChange[] = [];
  configure(change: AgentConfigChange): Promise<void> {
    if (change.sessionId !== "s1") return Promise.reject(new AckFailure({ code: "agent_not_found", message: "gone" }));
    this.configured.push(change);
    return Promise.resolve();
  }
  aborted: string[] = [];
  abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
    return Promise.resolve();
  }
  ended: string[] = [];
  end(sessionId: string): Promise<void> {
    this.ended.push(sessionId);
    return Promise.resolve();
  }
  readonly answered: [string, string, readonly AgentAskAnswer[]][] = [];
  answerAsk(sessionId: string, askId: string, results: readonly AgentAskAnswer[]): Promise<void> {
    if (sessionId !== "s1") return Promise.reject(new AckFailure({ code: "agent_not_found", message: "gone" }));
    this.answered.push([sessionId, askId, results]);
    return Promise.resolve();
  }
  readonly cancelled: [string, string][] = [];
  cancelAsk(sessionId: string, askId: string): Promise<void> {
    if (sessionId !== "s1") return Promise.reject(new AckFailure({ code: "agent_not_found", message: "gone" }));
    this.cancelled.push([sessionId, askId]);
    return Promise.resolve();
  }
  pending: AgentAsk | null = null;
  pendingAsk(sessionId: string): AgentAsk | null {
    return sessionId === "s1" ? this.pending : null;
  }
  readonly decided: [string, string, boolean, ApprovalConfirmation | undefined][] = [];
  decideApproval(sessionId: string, approvalId: string, allow: boolean, confirmed?: ApprovalConfirmation): Promise<void> {
    if (sessionId !== "s1") return Promise.reject(new AckFailure({ code: "agent_not_found", message: "gone" }));
    if (allow && this.approval?.requiresBiometric === true && confirmed === undefined) {
      return Promise.reject(new AckFailure({ code: "biometric_required", message: "needs Face ID" }));
    }
    this.decided.push([sessionId, approvalId, allow, confirmed]);
    return Promise.resolve();
  }
  approval: AgentApproval | null = null;
  pendingApproval(sessionId: string): AgentApproval | null {
    return sessionId === "s1" ? this.approval : null;
  }
  gate: GateStatus | null = null;
  readonly gateRuns: GateCommand[] = [];
  runGate(cmd: GateCommand): Promise<void> {
    if (cmd.kind === "gate.done" && cmd.photo === undefined) return Promise.reject(new AckFailure({ code: "gate_failed", message: "Draw needs a photo" }));
    this.gateRuns.push(cmd);
    return Promise.resolve();
  }
}

describe("agent topics", () => {
  it("welcomes with the provider's sessions and answers agents.get from the tracker", () => {
    const agents = new FakeProvider();
    const tracker = new AgentsDeltaTracker();
    tracker.seed(agents.sessions);
    const h = harness({ agents, tracker });
    pair(h);
    expect(h.sink.last()).toMatchObject({ t: "welcome", state: { mac: { agentsAvailable: true }, agents: { rev: 0, sessions: [{ id: "s1" }] } } });
    h.session.receive({ t: "agents.get" });
    expect(h.sink.last()).toMatchObject({ t: "agents.snapshot", rev: 0, sessions: [{ id: "s1" }] });
  });

  it("streams appended messages only while subscribed, with a per-subscription rev", async () => {
    const h = harness({ agents: new FakeProvider() });
    pair(h);
    h.session.receive({ t: "agent.subscribe", sessionId: "s1" });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toEqual({ t: "agent.conversation", sessionId: "s1", rev: 0, messages: [{ id: "m1", role: "user", text: "hi", at: 1 }] });
    const appended: AgentMessage[] = [{ id: "m2", role: "assistant", text: "yo", at: 2 }];
    h.session.agentConversationAppended("s1", appended);
    h.session.agentConversationAppended("s1", appended);
    h.session.agentConversationAppended("other", appended);
    expect(h.sink.sent.slice(-2)).toEqual([
      { t: "agent.messages", sessionId: "s1", rev: 1, append: appended },
      { t: "agent.messages", sessionId: "s1", rev: 2, append: appended },
    ]);
    h.session.receive({ t: "agent.unsubscribe", sessionId: "s1" });
    h.session.agentConversationAppended("s1", appended);
    expect(h.sink.sent).toHaveLength(7);
  });

  it("acks agent.reply through the provider and nacks unknown sessions", async () => {
    const agents = new FakeProvider();
    const h = harness({ agents });
    pair(h);
    h.session.receive({ t: "cmd", id: "r1", cmd: { kind: "agent.reply", sessionId: "s1", text: "ship it", submit: true } });
    h.session.receive({ t: "cmd", id: "r2", cmd: { kind: "agent.reply", sessionId: "nope", text: "x", submit: false } });
    await h.sink.sentCount(6);
    expect(agents.replies).toEqual([["s1", "ship it", true, undefined]]);
    expect(h.sink.sent.slice(-2)).toEqual([
      { t: "ack", id: "r1" },
      { t: "nack", id: "r2", error: { code: "agent_not_found", message: "gone" } },
    ]);
  });

  it("passes reply images through to the provider", async () => {
    const agents = new FakeProvider();
    const h = harness({ agents });
    pair(h);
    const images: AgentImage[] = [{ mimeType: "image/jpeg", data: "/9j/4AAQ" }];
    h.session.receive({ t: "cmd", id: "i1", cmd: { kind: "agent.reply", sessionId: "s1", text: "", submit: true, images } });
    await h.sink.sentCount(5);
    expect(agents.replies).toEqual([["s1", "", true, images]]);
    expect(h.sink.last()).toEqual({ t: "ack", id: "i1" });
  });

  it("nacks an empty reply and images without submit as invalid_command before reaching the provider", async () => {
    const agents = new FakeProvider();
    const h = harness({ agents });
    pair(h);
    h.session.receive({ t: "cmd", id: "e1", cmd: { kind: "agent.reply", sessionId: "s1", text: "", submit: true } });
    h.session.receive({ t: "cmd", id: "e2", cmd: { kind: "agent.reply", sessionId: "s1", text: "look", submit: false, images: [{ mimeType: "image/png", data: "iVBOR" }] } });
    await h.sink.sentCount(6);
    expect(agents.replies).toEqual([]);
    expect(h.sink.sent.slice(-2)).toMatchObject([
      { t: "nack", id: "e1", error: { code: "invalid_command" } },
      { t: "nack", id: "e2", error: { code: "invalid_command" } },
    ]);
  });

  it("passes a named omp profile when starting a session", async () => {
    const agents = new FakeProvider();
    const h = harness({ agents });
    pair(h);
    h.session.receive({ t: "cmd", id: "start-profile", cmd: { kind: "agent.start", prompt: "hello", thinkingLevel: "high", profile: "work" } });
    await h.sink.sentCount(5);
    expect(agents.launched).toEqual([["hello", "high", "work"]]);
    expect(h.sink.last()).toEqual({ t: "ack", id: "start-profile" });
  });

  it("answers agent.image with the provider's bytes and null for an unknown id", async () => {
    const h = harness({ agents: new FakeProvider() });
    pair(h);
    h.session.receive({ t: "agent.image", sessionId: "s1", id: "img1" });
    h.session.receive({ t: "agent.image", sessionId: "s1", id: "nope" });
    await h.sink.sentCount(6);
    expect(h.sink.sent.slice(-2)).toEqual([
      { t: "agent.image", sessionId: "s1", id: "img1", image: { mimeType: "image/png", data: "iVBOR" } },
      { t: "agent.image", sessionId: "s1", id: "nope", image: null },
    ]);
  });

  it("answers agent.options with the provider's models and skills, empty for unknown sessions", async () => {
    const h = harness({ agents: new FakeProvider() });
    pair(h);
    h.session.receive({ t: "agent.options", sessionId: "s1" });
    h.session.receive({ t: "agent.options", sessionId: "nope" });
    await h.sink.sentCount(6);
    expect(h.sink.sent.slice(-2)).toEqual([
      {
        t: "agent.options",
        sessionId: "s1",
        models: [{ provider: "anthropic", id: "m", name: "M", vendor: "anthropic", thinkingLevels: ["off", "low"] }],
        skills: [{ name: "deploy", description: "Ship it", command: "/skill:deploy", takesText: true }],
      },
      { t: "agent.options", sessionId: "nope", models: [], skills: [] },
    ]);
  });

  it("forwards agent.configure fields without the kind and nacks unknown sessions", async () => {
    const agents = new FakeProvider();
    const h = harness({ agents });
    pair(h);
    h.session.receive({ t: "cmd", id: "c1", cmd: { kind: "agent.configure", sessionId: "s1", title: "Renamed", thinkingLevel: "high" } });
    h.session.receive({ t: "cmd", id: "c2", cmd: { kind: "agent.configure", sessionId: "nope", title: "x" } });
    await h.sink.sentCount(6);
    expect(agents.configured).toEqual([{ sessionId: "s1", title: "Renamed", thinkingLevel: "high" }]);
    expect(h.sink.sent.slice(-2)).toEqual([
      { t: "ack", id: "c1" },
      { t: "nack", id: "c2", error: { code: "agent_not_found", message: "gone" } },
    ]);
  });

  it("replays a pending ask on subscribe, forwards its resolve, and drives answerAsk", async () => {
    const agents = new FakeProvider();
    const ask: AgentAsk = { id: "a1", questions: [{ id: "q1", question: "Ship it?", options: [{ label: "yes" }, { label: "no" }] }] };
    agents.pending = ask;
    const h = harness({ agents });
    pair(h);
    h.session.receive({ t: "agent.subscribe", sessionId: "s1" });
    // The session was already blocked on the ask: the phone gets the card right after the conversation.
    await h.sink.sentCount(6);
    expect(h.sink.sent.slice(-2)).toEqual([
      { t: "agent.conversation", sessionId: "s1", rev: 0, messages: [{ id: "m1", role: "user", text: "hi", at: 1 }] },
      { t: "agent.ask", sessionId: "s1", ask },
    ]);
    // A resolve only reaches the subscribed session.
    h.session.agentAskResolved("s1", "a1");
    h.session.agentAskResolved("other", "a1");
    expect(h.sink.last()).toEqual({ t: "agent.ask.resolved", sessionId: "s1", id: "a1" });
    // Answering drives the provider and acks; an unknown session nacks.
    const results: AgentAskAnswer[] = [{ id: "q1", selectedOptions: ["yes"] }];
    h.session.receive({ t: "cmd", id: "k1", cmd: { kind: "agent.ask.answer", sessionId: "s1", askId: "a1", results } });
    h.session.receive({ t: "cmd", id: "k2", cmd: { kind: "agent.ask.answer", sessionId: "nope", askId: "a1", results } });
    await h.sink.sentCount(9);
    expect(agents.answered).toEqual([["s1", "a1", results]]);
    expect(h.sink.sent.slice(-2)).toEqual([
      { t: "ack", id: "k1" },
      { t: "nack", id: "k2", error: { code: "agent_not_found", message: "gone" } },
    ]);
  });
});

describe("tool approvals", () => {
  it("replays a pending approval on subscribe, forwards its resolve, and drives decideApproval", async () => {
    const agents = new FakeProvider();
    const approval: AgentApproval = { id: "t1", toolName: "bash", command: "Command: git push --force", destructive: "force push", requiresBiometric: true };
    agents.approval = approval;
    const h = harness({ agents });
    pair(h);
    h.session.receive({ t: "agent.subscribe", sessionId: "s1" });
    await h.sink.sentCount(6);
    expect(h.sink.last()).toEqual({ t: "agent.approval", sessionId: "s1", approval });
    h.session.agentApprovalResolved("s1", "t1");
    h.session.agentApprovalResolved("other", "t1");
    expect(h.sink.last()).toEqual({ t: "agent.approval.resolved", sessionId: "s1", id: "t1" });
    // Destructive: approving needs a confirmation, denying never does, an unknown session nacks.
    h.session.receive({ t: "cmd", id: "k1", cmd: { kind: "agent.approve", sessionId: "s1", approvalId: "t1" } });
    h.session.receive({ t: "cmd", id: "k2", cmd: { kind: "agent.approve", sessionId: "s1", approvalId: "t1", confirmed: "biometric" } });
    h.session.receive({ t: "cmd", id: "k3", cmd: { kind: "agent.deny", sessionId: "s1", approvalId: "t1" } });
    h.session.receive({ t: "cmd", id: "k4", cmd: { kind: "agent.deny", sessionId: "nope", approvalId: "t1" } });
    await h.sink.sentCount(11);
    expect(agents.decided).toEqual([
      ["s1", "t1", true, "biometric"],
      ["s1", "t1", false, undefined],
    ]);
    expect(h.sink.sent.slice(-4)).toEqual([
      { t: "nack", id: "k1", error: { code: "biometric_required", message: "needs Face ID" } },
      { t: "ack", id: "k2" },
      { t: "ack", id: "k3" },
      { t: "nack", id: "k4", error: { code: "agent_not_found", message: "gone" } },
    ]);
  });
});

class FakeInbox implements InboxRelaying {
  readonly items: [string, InboxItem][] = [];
  readonly resolved: [string, string][] = [];
  readonly claims: [string, string, string][] = [];
  readonly released: string[] = [];
  open: InboxItem[] = [];
  item(deviceId: string, item: InboxItem): void {
    this.items.push([deviceId, item]);
  }
  resolve(deviceId: string, resolve: { id: string }): void {
    this.resolved.push([deviceId, resolve.id]);
  }
  pending(): readonly InboxItem[] {
    return this.open;
  }
  claim(id: string, deviceId: string, answer: string): void {
    this.claims.push([id, deviceId, answer]);
  }
  release(id: string): void {
    this.released.push(id);
  }
  readonly settledIds: string[] = [];
  settled(kind: "approval" | "ask", requestId: string): void {
    this.settledIds.push(`${kind}:${requestId}`);
  }
}

describe("phone escalation inbox", () => {
  const item: InboxItem = { id: "approval:t1", kind: "alert", title: "t", body: "b", at: 1 };

  it("hands inbox frames to the inbox with the sending device, and replays open items to a phone, not to EvaOS", () => {
    const inbox = new FakeInbox();
    inbox.open = [item];
    const evaos = harness({ inbox });
    pair(evaos, "evaos");
    expect(evaos.sink.sent.filter((m) => m.t === "inbox.item")).toEqual([]);
    evaos.session.receive({ t: "inbox.item", item });
    evaos.session.receive({ t: "inbox.resolve", id: "approval:t1", by: "mac" });
    expect(inbox.items).toEqual([["evaos", item]]);
    expect(inbox.resolved).toEqual([["evaos", "approval:t1"]]);
    const phone = harness({ inbox });
    pair(phone);
    expect(phone.sink.last()).toEqual({ t: "inbox.item", item });
  });

  it("claims a phone's approve, deny and ask answer before running it, and gives the claim back when it fails", async () => {
    const inbox = new FakeInbox();
    const agents = new FakeProvider();
    agents.approval = { id: "t1", toolName: "bash", command: "git push --force", destructive: "force push", requiresBiometric: true };
    const h = harness({ agents, inbox });
    pair(h);
    h.session.receive({ t: "cmd", id: "k1", cmd: { kind: "agent.approve", sessionId: "s1", approvalId: "t1" } });
    h.session.receive({ t: "cmd", id: "k2", cmd: { kind: "agent.approve", sessionId: "s1", approvalId: "t1", confirmed: "biometric" } });
    h.session.receive({ t: "cmd", id: "k3", cmd: { kind: "agent.deny", sessionId: "s1", approvalId: "t2" } });
    h.session.receive({ t: "cmd", id: "k4", cmd: { kind: "agent.ask.answer", sessionId: "s1", askId: "a1", results: [{ id: "q1", selectedOptions: ["Yes"] }] } });
    await h.sink.sentCount(5);
    expect(inbox.claims).toEqual([
      ["approval:t1", "phone-1", "Approved"],
      ["approval:t1", "phone-1", "Approved"],
      ["approval:t2", "phone-1", "Denied"],
      ["ask:a1", "phone-1", "Yes"],
    ]);
    // k1 had no Face ID: refused, so its claim is given back.
    expect(inbox.released).toEqual(["approval:t1"]);
  });
});

describe("usage", () => {
  it("answers usage.get with the service's snapshot and refreshes it when old, or an empty one without a service", () => {
    const snapshot = { accounts: [], updatedAt: 5, refreshing: false };
    const calls: string[] = [];
    const usage: UsageService = {
      get: () => snapshot,
      refresh: () => (calls.push("refresh"), Promise.resolve(snapshot)),
      refreshIfOld: () => void calls.push("refreshIfOld"),
    };
    const h = harness({ usage });
    pair(h);
    h.session.receive({ t: "usage.get" });
    expect(h.sink.last()).toEqual({ t: "usage.snapshot", usage: snapshot });
    h.session.receive({ t: "usage.refresh" });
    expect(calls).toEqual(["refreshIfOld", "refresh"]);
    const bare = harness();
    pair(bare);
    bare.session.receive({ t: "usage.get" });
    expect(bare.sink.last()).toEqual({ t: "usage.snapshot", usage: { accounts: [], updatedAt: null, refreshing: false } });
  });
});

describe("catch up", () => {
  it("answers catchup.list with the deck; mark, handoff and bounce change it or re-send the deck when nothing changed; note answers whether it was saved", () => {
    const card = { id: "slack:1", source: "slack" as const, label: "#general", title: "t", body: "", ts: "2026-10-24T00:00:00.000Z", importance: 3, read: false };
    const marks: string[] = [];
    const catchup: CatchUpDeck = {
      snapshot: () => ({ items: [card], unreadCount: 1 }),
      mark: (id, read) => (marks.push(`${id}:${String(read)}`), id === "slack:1"),
      handoff: (id, agent, note) => (marks.push(`handoff ${id} ${agent} ${note ?? "-"}`), agent === "astra"),
      bounce: (id, agent, reason) => (marks.push(`bounce ${id} ${agent} ${reason}`), id === "slack:1"),
      note: (id, text, signal) => (marks.push(`note ${id} ${signal ?? "-"} ${text}`), id === "slack:1"),
    };
    const h = harness({ catchup });
    pair(h);
    h.session.receive({ t: "catchup.list" });
    expect(h.sink.last()).toEqual({ t: "catchup.snapshot", items: [card], unreadCount: 1 });
    const sent = h.sink.sent.length;
    h.session.receive({ t: "catchup.mark", id: "slack:1", read: true });
    expect(h.sink.sent.length).toBe(sent); // the change goes out through the server's broadcast
    h.session.receive({ t: "catchup.mark", id: "gone", read: true });
    expect(h.sink.last()).toEqual({ t: "catchup.snapshot", items: [card], unreadCount: 1 });
    h.session.receive({ t: "catchup.handoff", id: "slack:1", agent: "astra", note: "ask Todd" });
    expect(h.sink.sent.length).toBe(sent + 1);
    h.session.receive({ t: "catchup.handoff", id: "slack:1", agent: "zed" });
    expect(h.sink.sent.length).toBe(sent + 2);
    h.session.receive({ t: "catchup.bounce", id: "slack:1", agent: "astra", reason: "personal" });
    expect(h.sink.sent.length).toBe(sent + 2);
    h.session.receive({ t: "catchup.note", id: "slack:1", signal: "fyi", text: "just context" });
    expect(h.sink.last()).toEqual({ t: "catchup.noted", id: "slack:1", ok: true });
    h.session.receive({ t: "catchup.note", id: "gone", text: "x" });
    expect(h.sink.last()).toEqual({ t: "catchup.noted", id: "gone", ok: false });
    expect(marks).toEqual([
      "slack:1:true",
      "gone:true",
      "handoff slack:1 astra ask Todd",
      "handoff slack:1 zed -",
      "bounce slack:1 astra personal",
      "note slack:1 fyi just context",
      "note gone - x",
    ]);
    const bare = harness();
    pair(bare);
    bare.session.receive({ t: "catchup.list" });
    expect(bare.sink.last()).toEqual({ t: "catchup.snapshot", items: [], unreadCount: 0 });
    bare.session.receive({ t: "catchup.mark", id: "x", read: true });
    expect(bare.sink.last()).toEqual({ t: "catchup.snapshot", items: [], unreadCount: 0 });
    bare.session.receive({ t: "catchup.note", id: "x", signal: "needs-me", text: "" });
    expect(bare.sink.last()).toEqual({ t: "catchup.noted", id: "x", ok: false });
  });
});

describe("reactions", () => {
  it("answers reactions.get with the thread's reactions; set and clear go to the service, and a no-op re-sends the thread to this device", () => {
    const thread = { "assistant@5": { isaac: { emoji: "👍", excerpt: "Done.", at: 9 } } };
    const calls: string[] = [];
    const reactions: ReactionRelaying = {
      snapshot: (id) => (id === "assistant:astra" ? thread : {}),
      set: (id, key, emoji, excerpt) => (calls.push(`set ${id} ${key} ${emoji} ${excerpt}`), emoji !== "👍"),
      clear: (id, key) => (calls.push(`clear ${id} ${key}`), key === "assistant@5"),
      observe: () => undefined,
    };
    const h = harness({ reactions });
    pair(h);
    h.session.receive({ t: "reactions.get", thread: "assistant:astra" });
    expect(h.sink.last()).toEqual({ t: "reactions.snapshot", thread: "assistant:astra", reactions: thread });
    const sent = h.sink.sent.length;
    h.session.receive({ t: "reaction.set", thread: "assistant:astra", message: "assistant@5", emoji: "❤️", excerpt: "Done." });
    h.session.receive({ t: "reaction.clear", thread: "assistant:astra", message: "assistant@5" });
    expect(h.sink.sent.length).toBe(sent); // changes go out through the service's broadcast
    h.session.receive({ t: "reaction.set", thread: "assistant:astra", message: "assistant@5", emoji: "👍", excerpt: "Done." });
    expect(h.sink.last()).toEqual({ t: "reactions.snapshot", thread: "assistant:astra", reactions: thread });
    h.session.receive({ t: "reaction.clear", thread: "session:s1", message: "user@1" });
    expect(h.sink.last()).toEqual({ t: "reactions.snapshot", thread: "session:s1", reactions: {} });
    expect(calls).toEqual([
      "set assistant:astra assistant@5 ❤️ Done.",
      "clear assistant:astra assistant@5",
      "set assistant:astra assistant@5 👍 Done.",
      "clear session:s1 user@1",
    ]);
    const bare = harness();
    pair(bare);
    bare.session.receive({ t: "reaction.set", thread: "session:s1", message: "user@1", emoji: "👍", excerpt: "" });
    expect(bare.sink.last()).toEqual({ t: "reactions.snapshot", thread: "session:s1", reactions: {} });
  });
});

describe("artifacts", () => {
  it("hands artifacts.get to the service (which broadcasts), answers artifacts.act with artifacts.acted, and serves defaults without a service", () => {
    const calls: string[] = [];
    const artifacts: ArtifactRelaying = {
      get: (thread) => void calls.push(`get ${thread}`),
      act: (thread, by, action) => (calls.push(`act ${thread} ${by} ${action.op}`), action.op === "pin" ? { ok: true } : { ok: false, error: "nope" }),
      openMedia: () => null,
      observe: () => undefined,
    };
    const h = harness({ artifacts });
    pair(h);
    const sent = h.sink.sent.length;
    h.session.receive({ t: "artifacts.get", thread: "assistant:astra" });
    expect(h.sink.sent.length).toBe(sent);
    h.session.receive({ t: "artifacts.act", thread: "assistant:astra", rid: "r1", by: "isaac", action: { op: "pin", id: "linear:ENG-1", pinned: true } });
    expect(h.sink.last()).toEqual({ t: "artifacts.acted", rid: "r1", ok: true });
    h.session.receive({ t: "artifacts.act", thread: "session:s1", rid: "r2", by: "nova", action: { op: "tab.remove", tab: "links" } });
    expect(h.sink.last()).toEqual({ t: "artifacts.acted", rid: "r2", ok: false, error: "nope" });
    expect(calls).toEqual(["get assistant:astra", "act assistant:astra isaac pin", "act session:s1 nova tab.remove"]);
    const bare = harness();
    pair(bare);
    bare.session.receive({ t: "artifacts.get", thread: "session:s1" });
    expect(bare.sink.last()).toEqual({ t: "artifacts.snapshot", thread: "session:s1", items: [], tabs: defaultTabs() });
    bare.session.receive({ t: "artifacts.act", thread: "session:s1", rid: "r3", by: "isaac", action: { op: "pin", id: "x", pinned: true } });
    expect(bare.sink.last()).toMatchObject({ t: "artifacts.acted", rid: "r3", ok: false });
  });
});

describe("habit gate", () => {
  const locked: GateStatus = { locked: true, blocked: true, reason: "planned break", active: null, habits: [{ id: "draw", name: "Draw", minutes: 10, photo: true }], tasks: [], canFinish: false, remainingSeconds: null };

  it("answers gate.get with the provider's gate, or null without a provider", () => {
    const agents = new FakeProvider();
    agents.gate = locked;
    const h = harness({ agents });
    pair(h);
    h.session.receive({ t: "gate.get" });
    expect(h.sink.last()).toEqual({ t: "gate.status", gate: locked });
    const bare = harness();
    pair(bare);
    bare.session.receive({ t: "gate.get" });
    expect(bare.sink.last()).toEqual({ t: "gate.status", gate: null });
  });

  it("runs gate commands through the provider and passes its failures through as nacks", async () => {
    const agents = new FakeProvider();
    const h = harness({ agents });
    pair(h);
    const photo: AgentImage = { mimeType: "image/jpeg", data: "/9j/4AAQ" };
    h.session.receive({ t: "cmd", id: "g1", cmd: { kind: "gate.start", id: "draw" } });
    h.session.receive({ t: "cmd", id: "g2", cmd: { kind: "gate.done", id: "draw" } });
    h.session.receive({ t: "cmd", id: "g3", cmd: { kind: "gate.done", id: "draw", photo } });
    h.session.receive({ t: "cmd", id: "g4", cmd: { kind: "gate.override", reason: "on call" } });
    await h.sink.sentCount(8);
    expect(agents.gateRuns).toEqual([
      { kind: "gate.start", id: "draw" },
      { kind: "gate.done", id: "draw", photo },
      { kind: "gate.override", reason: "on call" },
    ]);
    expect(h.sink.sent.slice(-4)).toEqual([
      { t: "ack", id: "g1" },
      { t: "nack", id: "g2", error: { code: "gate_failed", message: "Draw needs a photo" } },
      { t: "ack", id: "g3" },
      { t: "ack", id: "g4" },
    ]);
  });

  it("nacks gate commands as gate_unavailable on a host without an agent bridge", async () => {
    const h = harness();
    pair(h);
    h.session.receive({ t: "cmd", id: "g1", cmd: { kind: "gate.start", id: "walk" } });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toMatchObject({ t: "nack", id: "g1", error: { code: "gate_unavailable" } });
  });
});

describe("assistant threads", () => {
  class FakeThread implements AssistantThread {
    readonly turns: string[] = [];
    readonly turnImages: (readonly AgentImage[] | undefined)[] = [];
    readonly snapshotValue: AssistantSnapshot;
    constructor(
      readonly id: string,
      readonly title: string,
    ) {
      this.snapshotValue = { rev: 3, messages: [{ id: `${id}-a1`, role: "assistant", text: `hi from ${title}`, at: 1 }], busy: true, sessionId: `${id}-1` };
    }
    snapshot(): Promise<AssistantSnapshot> {
      return Promise.resolve(this.snapshotValue);
    }
    listing(): Promise<AssistantAgent> {
      return Promise.resolve({ id: this.id, title: this.title, scope: `${this.title} scope`, status: "idle", lastReply: { text: `hi from ${this.title}`, at: 1 } });
    }
    turn(text: string, images?: readonly AgentImage[]): Promise<void> {
      if (text === "fail") return Promise.reject(new AckFailure({ code: "agent_launch_failed", message: `${this.title} did not come up` }));
      this.turns.push(text);
      this.turnImages.push(images);
      return Promise.resolve();
    }
    say(text: string): Promise<void> {
      return this.turn(`[From ${this.title}'s background jobs] ${text}`);
    }
    readonly signins: string[][] = [];
    signin(messageId: string, url: string, username: string, password: string): Promise<void> {
      if (password === "wrong") return Promise.reject(new AckFailure({ code: "invalid_command", message: "Incorrect password." }));
      this.signins.push([messageId, url, username, password]);
      return Promise.resolve();
    }
  }

  class FakeThreads implements AssistantRelaying {
    readonly astra = new FakeThread("astra", "Astra");
    readonly nova = new FakeThread("nova", "Nova");
    readonly threads = [this.astra, this.nova];
    thread(id: string | undefined): FakeThread | undefined {
      return id === undefined ? this.astra : this.threads.find((thread) => thread.id === id);
    }
    agents(): Promise<AssistantAgent[]> {
      return Promise.all(this.threads.map((thread) => thread.listing()));
    }
    observe(): void {
      // nothing to watch here
    }
  }

  it("answers assistant.get without an agent with the default (first) agent's snapshot and follows only it for a while", async () => {
    const assistant = new FakeThreads();
    const h = harness({ assistant });
    pair(h);
    expect(h.session.isFollowingAssistant("astra")).toBe(false);
    h.session.receive({ t: "assistant.get" });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toEqual({ t: "assistant.snapshot", agent: "astra", snapshot: assistant.astra.snapshotValue });
    expect(h.session.isFollowingAssistant("astra")).toBe(true);
    expect(h.session.isFollowingAssistant("nova")).toBe(false);
    h.clock.advance(ASSISTANT_FOLLOW_MS + 1);
    expect(h.session.isFollowingAssistant("astra")).toBe(false);
    h.session.receive({ t: "assistant.get" });
    expect(h.session.isFollowingAssistant("astra")).toBe(true);
  });

  it("answers assistant.get for a named agent with that agent's snapshot, following each agent separately", async () => {
    const assistant = new FakeThreads();
    const h = harness({ assistant });
    pair(h);
    h.session.receive({ t: "assistant.get", agent: "nova" });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toEqual({ t: "assistant.snapshot", agent: "nova", snapshot: assistant.nova.snapshotValue });
    expect(h.session.isFollowingAssistant("nova")).toBe(true);
    expect(h.session.isFollowingAssistant("astra")).toBe(false);
  });

  it("answers assistant.get for an unknown agent empty and follows nothing; without an agent on a host with no threads, says nothing", async () => {
    const h = harness({ assistant: new FakeThreads() });
    pair(h);
    h.session.receive({ t: "assistant.get", agent: "eva" });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toEqual({ t: "assistant.snapshot", agent: "eva", snapshot: { rev: 0, messages: [], busy: false, sessionId: "" } });
    expect(h.session.isFollowingAssistant("eva")).toBe(false);
    const bare = harness();
    pair(bare);
    const before = bare.sink.sent.length;
    bare.session.receive({ t: "assistant.get" });
    expect(bare.sink.sent).toHaveLength(before);
    bare.session.receive({ t: "assistant.get", agent: "astra" });
    expect(bare.sink.last()).toEqual({ t: "assistant.snapshot", agent: "astra", snapshot: { rev: 0, messages: [], busy: false, sessionId: "" } });
  });

  it("lists the agents in registry order with their scope, status and last reply, and none on a host without threads", async () => {
    const h = harness({ assistant: new FakeThreads() });
    pair(h);
    h.session.receive({ t: "assistant.agents" });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toEqual({
      t: "assistant.agents",
      agents: [
        { id: "astra", title: "Astra", scope: "Astra scope", status: "idle", lastReply: { text: "hi from Astra", at: 1 } },
        { id: "nova", title: "Nova", scope: "Nova scope", status: "idle", lastReply: { text: "hi from Nova", at: 1 } },
      ],
    });
    const bare = harness();
    pair(bare);
    bare.session.receive({ t: "assistant.agents" });
    expect(bare.sink.last()).toEqual({ t: "assistant.agents", agents: [] });
  });

  it("hands assistant.turn to the named agent (the default when absent) and acks, passing its launch failure through as a nack", async () => {
    const assistant = new FakeThreads();
    const h = harness({ assistant });
    pair(h);
    h.session.receive({ t: "cmd", id: "t1", cmd: { kind: "assistant.turn", text: "what did the run do?" } });
    h.session.receive({ t: "cmd", id: "t2", cmd: { kind: "assistant.turn", agent: "nova", text: "fail" } });
    h.session.receive({ t: "cmd", id: "t3", cmd: { kind: "assistant.turn", agent: "nova", text: "dinner?" } });
    await h.sink.sentCount(7);
    expect(assistant.astra.turns).toEqual(["what did the run do?"]);
    expect(assistant.nova.turns).toEqual(["dinner?"]);
    expect(h.sink.sent.slice(-3)).toEqual([
      { t: "ack", id: "t1" },
      { t: "nack", id: "t2", error: { code: "agent_launch_failed", message: "Nova did not come up" } },
      { t: "ack", id: "t3" },
    ]);
  });

  it("nacks assistant.turn and assistant.signin for an unknown agent as agent_not_found", async () => {
    const h = harness({ assistant: new FakeThreads() });
    pair(h);
    h.session.receive({ t: "cmd", id: "t1", cmd: { kind: "assistant.turn", agent: "eva", text: "hello?" } });
    h.session.receive({ t: "cmd", id: "s1", cmd: { kind: "assistant.signin", agent: "eva", messageId: "a1", url: "https://github.com/login", username: "u", password: "p" } });
    await h.sink.sentCount(6);
    expect(h.sink.sent.slice(-2)).toMatchObject([
      { t: "nack", id: "t1", error: { code: "agent_not_found" } },
      { t: "nack", id: "s1", error: { code: "agent_not_found" } },
    ]);
  });

  it("hands assistant.signin to the named agent, and nacks the tool's error as invalid_command", async () => {
    const assistant = new FakeThreads();
    const h = harness({ assistant });
    pair(h);
    const url = "https://github.com/login";
    h.session.receive({ t: "cmd", id: "s1", cmd: { kind: "assistant.signin", agent: "nova", messageId: "a1", url, username: "isaac", password: "pw" } });
    h.session.receive({ t: "cmd", id: "s2", cmd: { kind: "assistant.signin", messageId: "a1", url, username: "isaac", password: "wrong" } });
    await h.sink.sentCount(6);
    expect(assistant.nova.signins).toEqual([["a1", url, "isaac", "pw"]]);
    expect(assistant.astra.signins).toEqual([]);
    expect(h.sink.sent.slice(-2)).toEqual([
      { t: "ack", id: "s1" },
      { t: "nack", id: "s2", error: { code: "invalid_command", message: "Incorrect password." } },
    ]);
  });

  it("nacks assistant.signin as agent_launch_failed on a host without threads", async () => {
    const h = harness();
    pair(h);
    h.session.receive({ t: "cmd", id: "s1", cmd: { kind: "assistant.signin", messageId: "a1", url: "https://github.com/login", username: "u", password: "p" } });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toMatchObject({ t: "nack", id: "s1", error: { code: "agent_launch_failed" } });
  });

  it("passes assistant.turn images through, and nacks a turn with neither text nor images as invalid_command", async () => {
    const assistant = new FakeThreads();
    const h = harness({ assistant });
    pair(h);
    const image = { mimeType: "image/png" as const, data: "AAAA" };
    h.session.receive({ t: "cmd", id: "t1", cmd: { kind: "assistant.turn", text: "", images: [image] } });
    h.session.receive({ t: "cmd", id: "t2", cmd: { kind: "assistant.turn", text: "" } });
    await h.sink.sentCount(6);
    expect(assistant.astra.turns).toEqual([""]);
    expect(assistant.astra.turnImages).toEqual([[image]]);
    expect(h.sink.sent.slice(-2)).toMatchObject([
      { t: "ack", id: "t1" },
      { t: "nack", id: "t2", error: { code: "invalid_command" } },
    ]);
  });

  it("nacks assistant.turn as agent_launch_failed on a host without threads", async () => {
    const h = harness();
    pair(h);
    h.session.receive({ t: "cmd", id: "t1", cmd: { kind: "assistant.turn", text: "hello?" } });
    await h.sink.sentCount(5);
    expect(h.sink.last()).toMatchObject({ t: "nack", id: "t1", error: { code: "agent_launch_failed" } });
  });
});

describe("AgentsDeltaTracker", () => {
  it("emits upserts for changed sessions, removes for missing ids, and bumps rev", () => {
    const tracker = new AgentsDeltaTracker();
    const a: AgentSession = { id: "a", provider: "omp", title: "a", projectPath: "/a", status: "idle", lastActivity: "", lastActivityAt: 1, canRespond: true };
    const b: AgentSession = { ...a, id: "b" };
    tracker.seed([a, b]);
    expect(tracker.apply([{ ...a, status: "working" }])).toEqual({ t: "agents.delta", rev: 1, upsert: [{ ...a, status: "working" }], remove: ["b"] });
    expect(tracker.apply([{ ...a, status: "working" }])).toEqual({ t: "agents.delta", rev: 2 });
  });

  it("treats a model or thinking-level change as an upsert", () => {
    const tracker = new AgentsDeltaTracker();
    const a: AgentSession = { id: "a", provider: "omp", title: "a", projectPath: "/a", status: "idle", lastActivity: "", lastActivityAt: 1, canRespond: true, model: "M", thinkingLevel: "medium" };
    tracker.seed([a]);
    expect(tracker.apply([{ ...a, thinkingLevel: "low" }])).toEqual({ t: "agents.delta", rev: 1, upsert: [{ ...a, thinkingLevel: "low" }] });
    expect(tracker.apply([{ ...a, thinkingLevel: "low", model: "N" }])).toEqual({ t: "agents.delta", rev: 2, upsert: [{ ...a, thinkingLevel: "low", model: "N" }] });
  });
});

describe("boards", () => {
  it("board.subscribe answers a snapshot and only subscribed sockets get deltas; board.get re-sends the snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-boards-"));
    try {
      const boards = new FileBoardStore(dir, () => undefined);
      const first = await boards.put("ops", { title: "Ops" });
      // Each harness has its own pairing coordinator, so both phones pair independently.
      const subscribed = harness({ boards });
      pair(subscribed);
      const other = harness({ boards });
      pair(other);
      boards.onChange = (delta) => {
        subscribed.session.boardChanged(delta);
        other.session.boardChanged(delta);
      };
      subscribed.session.receive({ t: "board.subscribe" });
      expect(subscribed.sink.last()).toEqual({ t: "board.snapshot", rev: 1, boards: [first] });
      const otherSent = other.sink.sent.length;
      const next = await boards.apply("ops", [{ op: "upsert", id: "a", spec: { widget: "divider" } }]);
      expect(subscribed.sink.last()).toEqual({ t: "board.delta", rev: 2, board: next });
      expect(other.sink.sent).toHaveLength(otherSent);
      other.session.receive({ t: "board.get" });
      expect(other.sink.last()).toEqual({ t: "board.snapshot", rev: 2, boards: [next] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a host without boards answers subscribe with an empty snapshot", () => {
    const h = harness();
    pair(h);
    h.session.receive({ t: "board.subscribe" });
    expect(h.sink.last()).toEqual({ t: "board.snapshot", rev: 0, boards: [] });
  });
});

describe("vnc", () => {
  it("hands an authenticated device a ticket while Screen Sharing is up", async () => {
    const asked: string[] = [];
    const h = harness({
      vnc: {
        open: (deviceId) => {
          asked.push(deviceId);
          return Promise.resolve("t1");
        },
      },
    });
    pair(h);
    const count = h.sink.sent.length;
    h.session.receive({ t: "vnc.open" });
    await h.sink.sentCount(count + 1);
    expect(h.sink.last()).toEqual({ t: "vnc.ticket", ticket: "t1" });
    expect(asked).toEqual(["phone-1"]);
  });

  it("answers unavailable when nothing listens on the VNC port", async () => {
    const h = harness();
    pair(h);
    const count = h.sink.sent.length;
    h.session.receive({ t: "vnc.open" });
    await h.sink.sentCount(count + 1);
    expect(h.sink.last()).toEqual({ t: "vnc.unavailable" });
  });

  it("refuses vnc.open before authentication", () => {
    let asked = false;
    const h = harness({
      vnc: {
        open: () => {
          asked = true;
          return Promise.resolve("t1");
        },
      },
    });
    h.session.receive({ t: "vnc.open" });
    expect(h.sink.last()).toEqual({ t: "error", code: "protocol", message: "expected hello" });
    expect(asked).toBe(false);
  });
});

describe("calls", () => {
  class FakeCalls implements CallRelaying {
    readonly received: { sink: FrameSink; message: CallClientMessage }[] = [];
    readonly dropped: FrameSink[] = [];
    receive(sink: FrameSink, message: CallClientMessage): void {
      this.received.push({ sink, message });
    }
    drop(sink: FrameSink): void {
      this.dropped.push(sink);
    }
    observe(): void {
      // Provider changes reach calls through the server, not the session.
    }
    warms = 0;
    warm(): void {
      this.warms += 1;
    }
  }

  it("warms the speech models when a phone opens an assistant's thread", () => {
    const calls = new FakeCalls();
    const empty: AssistantSnapshot = { rev: 0, messages: [], busy: false, sessionId: "" };
    const astra: AssistantThread = {
      id: "astra",
      title: "Astra",
      snapshot: () => Promise.resolve(empty),
      listing: () => Promise.resolve({ id: "astra", title: "Astra" }),
      turn: () => Promise.resolve(),
      say: () => Promise.resolve(),
      signin: () => Promise.resolve(),
    };
    const assistant: AssistantRelaying = {
      threads: [astra],
      thread: (id) => (id === "astra" ? astra : undefined),
      agents: () => Promise.resolve([]),
      observe: () => undefined,
    };
    const h = harness({ calls, assistant });
    pair(h);
    h.session.receive({ t: "assistant.get", agent: "astra" });
    expect(calls.warms).toBe(1);
    h.session.receive({ t: "assistant.get", agent: "eva" });
    expect(calls.warms).toBe(1);
  });

  it("hands every call frame to the calls with this socket's sink, and hangs up when the socket goes", () => {
    const calls = new FakeCalls();
    const h = harness({ calls });
    pair(h);
    const frames: CallClientMessage[] = [
      { t: "call.start", callId: "c1", agent: "astra" },
      { t: "call.audio", callId: "c1", pcm: "AAAA" },
      { t: "call.mute", callId: "c1", muted: true },
      { t: "call.end", callId: "c1" },
    ];
    for (const frame of frames) h.session.receive(frame);
    expect(calls.received.map((entry) => entry.message)).toEqual(frames);
    expect(calls.received.every((entry) => entry.sink === h.sink)).toBe(true);
    h.session.handleDisconnect();
    expect(calls.dropped).toEqual([h.sink]);
  });

  it("ends a call at once on a host that cannot take calls, and ignores its other frames", () => {
    const h = harness();
    pair(h);
    const before = h.sink.sent.length;
    h.session.receive({ t: "call.audio", callId: "c1", pcm: "AAAA" });
    expect(h.sink.sent).toHaveLength(before);
    h.session.receive({ t: "call.start", callId: "c1", agent: "astra" });
    expect(h.sink.last()).toEqual({ t: "call.state", callId: "c1", agent: "astra", state: "ended", error: "This host cannot take calls" });
  });

  it("refuses call frames before authentication", () => {
    const calls = new FakeCalls();
    const h = harness({ calls });
    h.session.receive({ t: "call.start", callId: "c1", agent: "astra" });
    expect(calls.received).toEqual([]);
    expect(h.sink.last()).toMatchObject({ t: "error", code: "protocol" });
  });
});
