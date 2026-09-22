// Port of ClientSession.swift. One phone<->host connection as a pure state machine over the seams
// in ./seams.ts: `awaitingHello -> (challenged | unpairedWaiting | pairingPending) ->
// authenticated -> closed`. Never touches a socket; outbound frames go through `FrameSink`.
//
// Linux v1 has no agent provider, so `agent.reply` nacks with `agent_cannot_respond` and the
// agents topic is a constant empty snapshot at rev 0.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  toHex,
  type AgentAsk,
  type AgentMessage,
  type AgentOptions,
  type ClientMessage,
  type Command,
  type ErrorCode,
  type ServerMessage,
  type Snapshot,
} from "@relay/protocol";
import type { AgentsDeltaTracker } from "./agents/delta-tracker";
import type { CommandDedupStore } from "./dedup";
import type { PairingCoordinator } from "./pairing";
import {
  AckFailure,
  type AgentProvider,
  type DeviceStore,
  type DropBox,
  type FrameSink,
  type ImagePasting,
  type InputAccess,
  type InputSink,
  type PushRegistry,
  type TextInjecting,
} from "./seams";

export interface SessionDeps {
  readonly hostName: string;
  readonly version: string;
  readonly input: InputSink;
  readonly text: TextInjecting;
  readonly access: InputAccess;
  readonly images: ImagePasting;
  readonly agents: AgentProvider | null;
  readonly agentsTracker: AgentsDeltaTracker;
  readonly devices: DeviceStore;
  /** null when the host cannot push; `push.register` is then accepted and dropped. */
  readonly push: PushRegistry | null;
  /** null when the host has no drop box; drop frames and commands are then refused. */
  readonly drops: DropBox | null;
  readonly pairing: PairingCoordinator;
  readonly dedup: CommandDedupStore;
}

/** Clock and scheduling seams so tests drive time deterministically. */
export interface SessionClock {
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
}

export const PAIRING_TIMEOUT_MS = 120_000;
const MAX_PIN_ATTEMPTS = 3;
const EMPTY_OPTIONS: AgentOptions = { models: [], skills: [] };

function noInputDevice(): AckFailure {
  return new AckFailure({
    code: "accessibility_denied",
    message: "virtual input device unavailable",
  });
}

type Phase =
  | { readonly kind: "awaitingHello" }
  | {
      readonly kind: "challenged";
      readonly deviceId: string;
      readonly nonce: string;
      readonly secret: Uint8Array;
    }
  | { readonly kind: "unpairedWaiting"; readonly deviceId: string; readonly deviceName: string }
  | {
      readonly kind: "pairingPending";
      readonly deviceId: string;
      readonly deviceName: string;
      readonly pin: string;
      attempts: number;
    }
  | { readonly kind: "authenticated"; readonly deviceId: string };

export const systemClock: SessionClock = {
  now: () => Date.now(),
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

export class ClientSession {
  private phase: Phase = { kind: "awaitingHello" };
  private cancelPairingTimeout: (() => void) | null = null;
  private closed = false;
  /** Set when the host ended the connection with an `error` frame: the code and message it sent. */
  private failure: string | null = null;
  private name: string | null = null;
  /** Per-conversation rev for `agent.messages`, keyed by the subscribed session id. */
  private readonly subscriptions = new Map<string, number>();

  constructor(
    private readonly sink: FrameSink,
    private readonly deps: SessionDeps,
    private readonly onClose: (session: ClientSession) => void,
    private readonly clock: SessionClock = systemClock,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get deviceName(): string | null {
    return this.name;
  }

  get closeReason(): string | null {
    return this.failure;
  }

  get deviceId(): string | null {
    return this.phase.kind === "awaitingHello" ? null : this.phase.deviceId;
  }

  get isAuthenticated(): boolean {
    return this.phase.kind === "authenticated";
  }

  /** Sends only once authenticated; used by the server for state-topic broadcasts (`mac.state`). */
  broadcast(message: ServerMessage): void {
    if (this.phase.kind === "authenticated") this.sink.send(message);
  }

  /** Whether the phone currently has `sessionId`'s conversation open (subscribed on this socket). */
  isSubscribed(sessionId: string): boolean {
    return this.phase.kind === "authenticated" && this.subscriptions.has(sessionId);
  }

  /** Forwards appended agent messages iff subscribed to `sessionId`; bumps that subscription's rev. */
  agentConversationAppended(sessionId: string, messages: readonly AgentMessage[]): void {
    if (this.phase.kind !== "authenticated" || messages.length === 0) return;
    const rev = this.subscriptions.get(sessionId);
    if (rev === undefined) return;
    this.subscriptions.set(sessionId, rev + 1);
    this.sink.send({ t: "agent.messages", sessionId, rev: rev + 1, append: [...messages] });
  }

  /** Forwards a streaming message's text so far iff subscribed; no rev, the frame is idempotent. */
  agentMessageUpdated(sessionId: string, id: string, text: string, streaming: boolean): void {
    if (this.phase.kind !== "authenticated" || !this.subscriptions.has(sessionId)) return;
    this.sink.send({ t: "agent.message.update", sessionId, id, text, streaming });
  }

  /** Shows a pending ask iff subscribed to `sessionId`; the phone renders it and may answer it. */
  agentAsk(sessionId: string, ask: AgentAsk): void {
    if (this.phase.kind !== "authenticated" || !this.subscriptions.has(sessionId)) return;
    this.sink.send({ t: "agent.ask", sessionId, ask });
  }

  /** Tells the phone a pending ask closed elsewhere iff subscribed; it dismisses that ask's card. */
  agentAskResolved(sessionId: string, id: string): void {
    if (this.phase.kind !== "authenticated" || !this.subscriptions.has(sessionId)) return;
    this.sink.send({ t: "agent.ask.resolved", sessionId, id });
  }

  receiveRaw(raw: string): void {
    if (this.closed) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.fail("protocol", `malformed frame: ${parsed.error}`);
      return;
    }
    this.receive(parsed.value);
  }

  receive(message: ClientMessage): void {
    if (this.closed) return;
    switch (this.phase.kind) {
      case "awaitingHello":
        this.handleAwaitingHello(message);
        break;
      case "challenged":
        this.handleChallenged(this.phase, message);
        break;
      case "unpairedWaiting":
        this.handleUnpairedWaiting(this.phase, message);
        break;
      case "pairingPending":
        this.handlePairingPending(this.phase, message);
        break;
      case "authenticated":
        this.handleAuthenticated(this.phase.deviceId, message);
        break;
    }
  }

  /** The connection dropped. No retry; the server frees the session after this returns. */
  handleDisconnect(): void {
    if (this.closed) return;
    this.endPairingIfPending();
    this.stopPairingTimeout();
    this.closed = true;
    this.onClose(this);
  }

  // Phases

  private handleAwaitingHello(message: ClientMessage): void {
    if (message.t !== "hello") {
      this.fail("protocol", "expected hello");
      return;
    }
    // Zod already pins `v` to the literal; keep the explicit check so a future bump fails loudly.
    if ((message.v as number) !== PROTOCOL_VERSION) {
      this.fail("version_mismatch", `unsupported protocol version ${message.v}`);
      return;
    }
    this.name = message.deviceName;
    const secret = this.deps.devices.secret(message.deviceId);
    if (secret !== null) {
      const nonce = toHex(randomBytes(32));
      this.phase = { kind: "challenged", deviceId: message.deviceId, nonce, secret };
      this.sink.send({ t: "challenge", nonce });
    } else {
      this.phase = {
        kind: "unpairedWaiting",
        deviceId: message.deviceId,
        deviceName: message.deviceName,
      };
      this.sink.send({ t: "unpaired" });
    }
  }

  private handleChallenged(
    phase: Extract<Phase, { kind: "challenged" }>,
    message: ClientMessage,
  ): void {
    if (message.t !== "auth") {
      this.fail("protocol", "expected auth");
      return;
    }
    if (message.proof.length !== 64 || /[^0-9a-f]/i.test(message.proof)) {
      this.fail("auth_failed", "malformed proof");
      return;
    }
    const expected = createHmac("sha256", phase.secret).update(phase.nonce, "utf8").digest();
    if (!timingSafeEqual(expected, Buffer.from(message.proof, "hex"))) {
      this.fail("auth_failed", "invalid proof");
      return;
    }
    this.authenticate(phase.deviceId);
  }

  private handleUnpairedWaiting(
    phase: Extract<Phase, { kind: "unpairedWaiting" }>,
    message: ClientMessage,
  ): void {
    if (message.t !== "pair.request") {
      this.fail("protocol", "expected pair.request");
      return;
    }
    const pin = randomInt(0, 1_000_000).toString().padStart(6, "0");
    if (!this.deps.pairing.begin(phase.deviceName, pin)) {
      this.fail("busy", "another pairing is already in progress");
      return;
    }
    this.phase = {
      kind: "pairingPending",
      deviceId: phase.deviceId,
      deviceName: phase.deviceName,
      pin,
      attempts: 0,
    };
    this.cancelPairingTimeout = this.clock.after(PAIRING_TIMEOUT_MS, () => {
      this.pairingTimedOut();
    });
    this.sink.send({ t: "pair.pending" });
  }

  private handlePairingPending(
    phase: Extract<Phase, { kind: "pairingPending" }>,
    message: ClientMessage,
  ): void {
    if (message.t !== "pair.confirm") {
      this.fail("protocol", "expected pair.confirm");
      return;
    }
    if (message.pin !== phase.pin) {
      phase.attempts += 1;
      if (phase.attempts >= MAX_PIN_ATTEMPTS) {
        this.stopPairingTimeout();
        this.deps.pairing.end();
        this.closed = true;
        this.sink.send({ t: "pair.failed", reason: "too_many_attempts" });
        this.sink.close();
        this.onClose(this);
      } else {
        this.sink.send({ t: "pair.failed", reason: "wrong_pin" });
      }
      return;
    }
    this.stopPairingTimeout();
    const secret = randomBytes(32);
    this.deps.devices.save(secret, phase.deviceId, phase.deviceName);
    this.deps.pairing.end();
    this.sink.send({ t: "pair.ok", secret: toHex(secret) });
    this.authenticate(phase.deviceId);
  }

  private handleAuthenticated(deviceId: string, message: ClientMessage): void {
    switch (message.t) {
      case "input":
        if (this.deps.access.granted) this.deps.input.handle(message.events);
        break;
      case "cmd":
        this.handleCmd(message.id, message.cmd, deviceId);
        break;
      case "ping":
        this.sink.send({ t: "pong", ts: message.ts, serverTs: this.clock.now() });
        break;
      case "agents.get":
        this.sink.send({
          t: "agents.snapshot",
          rev: this.deps.agentsTracker.rev,
          sessions: [...this.deps.agentsTracker.sessions],
        });
        break;
      case "agent.subscribe": {
        const { sessionId } = message;
        this.subscriptions.set(sessionId, 0);
        const lookup = this.deps.agents?.conversation(sessionId) ?? Promise.resolve(null);
        void lookup.then(
          (messages) => {
            // Still subscribed (no unsubscribe raced the lookup) and still on rev 0.
            if (this.closed || this.subscriptions.get(sessionId) !== 0) return;
            this.sink.send({
              t: "agent.conversation",
              sessionId,
              rev: 0,
              messages: messages ?? [],
            });
            // A session already blocked on an ask when the phone opens it still gets the card.
            const pending = this.deps.agents?.pendingAsk(sessionId) ?? null;
            if (pending !== null) this.agentAsk(sessionId, pending);
          },
          () => {
            if (this.closed || this.subscriptions.get(sessionId) !== 0) return;
            this.sink.send({ t: "agent.conversation", sessionId, rev: 0, messages: [] });
            const pending = this.deps.agents?.pendingAsk(sessionId) ?? null;
            if (pending !== null) this.agentAsk(sessionId, pending);
          },
        );
        break;
      }
      case "agent.unsubscribe":
        this.subscriptions.delete(message.sessionId);
        break;
      case "agent.options": {
        const { sessionId } = message;
        const lookup = this.deps.agents?.options(sessionId) ?? Promise.resolve(null);
        void lookup.then(
          (options) => {
            if (!this.closed)
              this.sink.send({ t: "agent.options", sessionId, ...(options ?? EMPTY_OPTIONS) });
          },
          () => {
            if (!this.closed) this.sink.send({ t: "agent.options", sessionId, ...EMPTY_OPTIONS });
          },
        );
        break;
      }
      case "agent.image": {
        const { sessionId, id } = message;
        const lookup = this.deps.agents?.image(sessionId, id) ?? Promise.resolve(null);
        void lookup.then(
          (image) => {
            if (!this.closed) this.sink.send({ t: "agent.image", sessionId, id, image });
          },
          () => {
            if (!this.closed) this.sink.send({ t: "agent.image", sessionId, id, image: null });
          },
        );
        break;
      }
      case "push.register":
        this.deps.push?.register(deviceId, message.token);
        break;
      case "push.unregister":
        this.deps.push?.unregister(deviceId);
        break;
      case "drop.list":
        this.sink.send({
          t: "drop.list",
          drops: this.deps.drops === null ? [] : [...this.deps.drops.list()],
        });
        break;
      case "hello":
      case "auth":
      case "pair.request":
      case "pair.confirm":
        this.fail("protocol", "unexpected handshake message while authenticated");
        break;
    }
  }

  private handleCmd(id: string, cmd: Command, deviceId: string): void {
    // `begin` marks the id in flight synchronously, before any await: a duplicate arriving while
    // the original runs registers as a waiter and gets the eventual response from `complete`.
    const lookup = this.deps.dedup.begin(deviceId, id, this.sink);
    if (lookup.kind === "completed") {
      this.sink.send(lookup.response);
      return;
    }
    if (lookup.kind === "inFlight") return;

    void this.execute(id, cmd).then((response) => {
      this.deps.dedup.complete(deviceId, id, response);
      // The waiter list never includes this sink; send to ourselves even if the socket closed
      // meanwhile (FrameSink.send after close is a no-op).
      this.sink.send(response);
    });
  }

  private async execute(id: string, cmd: Command): Promise<ServerMessage> {
    try {
      await this.run(cmd);
      return { t: "ack", id };
    } catch (error) {
      return error instanceof AckFailure
        ? { t: "nack", id, error: error.error }
        : {
            t: "nack",
            id,
            error: {
              code: "internal",
              message: error instanceof Error ? error.message : String(error),
            },
          };
    }
  }

  private run(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "text.insert":
        return this.deps.access.granted
          ? this.deps.text.insert(cmd.text)
          : Promise.reject(noInputDevice());
      case "key.press":
        return this.deps.access.granted
          ? this.deps.text.press(cmd.key)
          : Promise.reject(noInputDevice());
      case "clipboard.paste":
        return this.deps.access.granted
          ? this.deps.images.paste(cmd.image)
          : Promise.reject(noInputDevice());
      case "agent.reply": {
        // Wire shape allows both; the host rule is that a reply carries something, and that images
        // only ever go out as a turn (the editor holds text, not images).
        if (cmd.text.length === 0 && cmd.images === undefined) {
          return Promise.reject(
            new AckFailure({
              code: "invalid_command",
              message: "reply has neither text nor images",
            }),
          );
        }
        if (!cmd.submit && cmd.images !== undefined) {
          return Promise.reject(
            new AckFailure({
              code: "invalid_command",
              message: "images cannot be placed in the editor; submit them",
            }),
          );
        }
        return this.agents().reply(cmd.sessionId, cmd.text, cmd.submit, cmd.images);
      }
      case "agent.start":
        return this.agents().launch(cmd.prompt, cmd.thinkingLevel);
      case "agent.configure":
        return this.agents().configure({
          sessionId: cmd.sessionId,
          ...(cmd.title === undefined ? {} : { title: cmd.title }),
          ...(cmd.model === undefined ? {} : { model: cmd.model }),
          ...(cmd.thinkingLevel === undefined ? {} : { thinkingLevel: cmd.thinkingLevel }),
        });
      case "agent.abort":
        return this.agents().abort(cmd.sessionId);
      case "agent.end":
        return this.agents().end(cmd.sessionId);
      case "agent.ask.answer":
        return this.agents().answerAsk(cmd.sessionId, cmd.askId, cmd.results);
      case "agent.ask.cancel":
        return this.agents().cancelAsk(cmd.sessionId, cmd.askId);
      case "drop.put": {
        if ((cmd.text === undefined) === (cmd.image === undefined)) {
          return Promise.reject(
            new AckFailure({
              code: "invalid_command",
              message: "drop.put takes exactly one of text or image",
            }),
          );
        }
        const drops = this.drops();
        if (cmd.text !== undefined) {
          drops.putText("phone", cmd.text);
          return Promise.resolve();
        }
        const image = cmd.image;
        if (image === undefined) return Promise.resolve();
        const ext =
          image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/png" ? "png" : "webp";
        drops.putBlob("phone", {
          name: `phone-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`,
          mimeType: image.mimeType,
          bytes: Buffer.from(image.data, "base64"),
        });
        return Promise.resolve();
      }
      case "drop.delete":
        return this.drops().remove(cmd.id)
          ? Promise.resolve()
          : Promise.reject(
              new AckFailure({ code: "drop_not_found", message: `no drop ${cmd.id}` }),
            );
    }
  }

  private agents(): AgentProvider {
    if (this.deps.agents === null) {
      throw new AckFailure({
        code: "agent_cannot_respond",
        message: "no agent provider available",
      });
    }
    return this.deps.agents;
  }

  private drops(): DropBox {
    if (this.deps.drops === null)
      throw new AckFailure({ code: "drop_unavailable", message: "no drop box on this host" });
    return this.deps.drops;
  }

  private authenticate(deviceId: string): void {
    this.phase = { kind: "authenticated", deviceId };
    this.sink.send({ t: "welcome", state: this.snapshot() });
  }

  private snapshot(): Snapshot {
    return {
      mac: {
        name: this.deps.hostName,
        version: this.deps.version,
        accessibilityGranted: this.deps.access.granted,
        agentsAvailable: this.deps.agents?.isAvailable ?? false,
      },
      agents: { rev: this.deps.agentsTracker.rev, sessions: [...this.deps.agentsTracker.sessions] },
    };
  }

  // Pairing timeout

  private stopPairingTimeout(): void {
    this.cancelPairingTimeout?.();
    this.cancelPairingTimeout = null;
  }

  private pairingTimedOut(): void {
    if (this.phase.kind !== "pairingPending" || this.closed) return;
    this.deps.pairing.end();
    this.closed = true;
    this.sink.send({ t: "pair.failed", reason: "timeout" });
    this.sink.close();
    this.onClose(this);
  }

  private endPairingIfPending(): void {
    if (this.phase.kind === "pairingPending") this.deps.pairing.end();
  }

  // Errors

  private fail(code: ErrorCode, message: string): void {
    this.endPairingIfPending();
    this.stopPairingTimeout();
    this.closed = true;
    this.failure = `${code}: ${message}`;
    this.sink.send({ t: "error", code, message });
    this.sink.close();
    this.onClose(this);
  }
}
