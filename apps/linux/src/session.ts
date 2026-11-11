// Port of ClientSession.swift. One phone<->host connection as a pure state machine over the seams
// in ./seams.ts: `awaitingHello -> (challenged | unpairedWaiting | pairingPending) ->
// authenticated -> closed`. Never touches a socket; outbound frames go through `FrameSink`.
//
// Linux v1 has no agent provider, so `agent.reply` nacks with `agent_cannot_respond` and the
// agents topic is a constant empty snapshot at rev 0.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  CONTROL_FEATURE,
  BOOKMARKS_FEATURE,
  ESCALATOR_DEVICE_ID,
  FILES_PRESENCE_FEATURE,
  MEETINGS_FEATURE,
  RENDER_REPORT_FEATURE,
  PROTOCOL_VERSION,
  defaultTabs,
  parseClientMessage,
  QUERY_FEATURE,
  ROOMS_FEATURE,
  ROOMS_RESUME_FEATURE,
  ROOMS_CHAT_FEATURE,
  ROOMS_DECIDE_FEATURE,
  ASSISTANT_GUESTS_FEATURE,
  STATS_FEATURE,
  toHex,
  type AgentApproval,
  type AgentAsk,
  type AgentMessage,
  type AgentOptions,
  type AssistantSnapshot,
  type ClientMessage,
  type Command,
  type ErrorCode,
  type ServerMessage,
  type Snapshot,
} from "@relay/protocol";
import type { AgentsDeltaTracker } from "./agents/delta-tracker";
import type { SessionFiles } from "./agents/session-files";
import type { BoardDelta, FileBoardStore } from "./boards/store";
import { isLoopback } from "./boards/http";
import { EMPTY_CATCHUP, type CatchUpDeck } from "./catchup/service";
import { EMPTY_FEED, type FeedDeck } from "./feed/service";
import type { ReactionRelaying } from "./reactions/service";
import type { BookmarkRelaying } from "./bookmarks/service";
import type { ArtifactRelaying } from "./artifacts/service";
import type { ActivityRelaying } from "./activity/service";
import type { RenderFailureReporting } from "./render-failures/service";
import type { CommandDedupStore } from "./dedup";
import type { PairingCoordinator } from "./pairing";
import type { UsageService } from "./usage/service";
import type { StatsService } from "./stats/service";
import type { QueryRelaying } from "./query/service";
import {
  AckFailure,
  type AgentProvider,
  type AssistantRelaying,
  type AssistantThread,
  type CallRelaying,
  type CanvasRelaying,
  type ControlRelaying,
  type LiveRelaying,
  type DeviceStore,
  type DropBox,
  type FilePresenceRelaying,
  type FrameSink,
  type ImagePasting,
  type InboxRelaying,
  type InputAccess,
  type InputSink,
  type MeetingsRelaying,
  type PushRegistry,
  type ReviewsRelaying,
  type StudioRelaying,
  type TextInjecting,
  type VncAccess,
} from "./seams";
import type { RoomsRelaying } from "./rooms/relay";

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
  /** null when the host has no boards dir; `board.subscribe` then gets an empty snapshot. */
  readonly boards: FileBoardStore | null;
  readonly pairing: PairingCoordinator;
  /** Peer IP; tailnet addresses (Tailscale CGNAT / ULA ranges) pair without a PIN. */
  readonly remoteAddress: string;
  readonly dedup: CommandDedupStore;
  /** Tickets for the live view's VNC bridge. */
  readonly vnc: VncAccess;
  /** null when the host has no phone-escalation inbox; `inbox.*` frames are then ignored. */
  readonly inbox: InboxRelaying | null;
  /** null when the host has no assistant threads; `assistant.get` then answers empty and `assistant.turn` nacks. */
  readonly assistant: AssistantRelaying | null;
  /** null when the host cannot take calls; `call.start` then ends at once with an error. */
  readonly calls: CallRelaying | null;
  /** null when the host cannot take GPT-Live calls; `live.start` then ends at once with `fallback`. */
  readonly live: LiveRelaying | null;
  /** null when the host cannot read omp usage; `usage.*` then answers an empty snapshot. */
  readonly usage: UsageService | null;
  /** null when the host reads no omp stats; `stats.get` then answers an empty snapshot and `welcome.features` leaves it out. */
  readonly stats: StatsService | null;
  /** null when the host has no Catch Up feed; `catchup.*` then answers an empty deck. */
  readonly catchup: CatchUpDeck | null;
  /** null when the host has no discovery feed; `feed.list` then answers an empty feed and signals are dropped. */
  readonly feed: FeedDeck | null;
  /** null when the host keeps no reactions; `reactions.get` then answers empty and set/clear are dropped. */
  readonly reactions: ReactionRelaying | null;
  /** null when the host keeps no bookmarks; `bookmarks.get` then answers empty, set is dropped and `welcome.features` leaves it out. */
  readonly bookmarks: BookmarkRelaying | null;
  /** null when the host keeps no artifacts; `artifacts.get` then answers the default tabs with no items and every act is refused. */
  readonly artifacts: ArtifactRelaying | null;
  /** null when the host keeps no activity list; `activity.get` then answers an empty one. */
  readonly activity: ActivityRelaying | null;
  /** null when the host runs no live canvas; `canvas.get` then answers no rooms and `canvas.open` is unavailable. */
  readonly canvas: CanvasRelaying | null;
  /** null when the host has no omp agent dir; `sessions.list` then answers empty and reads answer null. */
  readonly sessionFiles: SessionFiles | null;
  /** null when the host runs no Studio; `studio.list` then answers empty and every `studio.req` is refused. */
  readonly studio: StudioRelaying | null;
  /** null when the host runs no Reviews; every `reviews.req` is then refused. */
  readonly reviews: ReviewsRelaying | null;
  /** null when the host runs no query tools; `query.req` is then refused and `welcome.features` leaves "query" out. */
  readonly query: QueryRelaying | null;
  /** null when the host runs no live file presence; `files.*` frames are then ignored and `welcome.features` leaves it out. */
  readonly files: FilePresenceRelaying | null;
  /** null when the host runs no Meetings; `meetings.list` then answers empty, `meetings.req` and `meeting.ingest.open` are refused. */
  readonly meetings: MeetingsRelaying | null;
  /** null when the host runs no remote control; `control.*` frames are then ignored and `welcome.features` leaves it out. */
  readonly control: ControlRelaying | null;
  /** Where `render.failed` reports go; absent or null drops them and leaves the feature out of `welcome.features`. */
  readonly renderFailures?: RenderFailureReporting | null;
  /** Rooms of the connected Relay Desktops; absent or null ignores `rooms.*` and leaves the feature out of `welcome.features`. */
  readonly rooms?: RoomsRelaying | null;
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
/**
 * A socket that asked for an agent's thread (`assistant.get`) follows that thread this long: it
 * gets every `assistant.snapshot` of that agent and its device gets no push for that agent. The
 * phone re-asks while the thread stays on screen; a socket that goes quiet drops out of the thread
 * without a frame to say so. Each agent is followed separately.
 */
export const ASSISTANT_FOLLOW_MS = 5 * 60_000;
const EMPTY_ASSISTANT: AssistantSnapshot = { rev: 0, messages: [], busy: false, sessionId: "" };

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
  /** Set by `board.subscribe`; only subscribed sockets get `board.delta`. */
  private boardsSubscribed = false;
  /** When this socket last sent `assistant.get`, by agent id; absent for agents it never asked for. */
  private readonly assistantAskedAt = new Map<string, number>();
  /** Set by `stats.get`: this socket shows usage stats and gets every new snapshot. */
  private statsWanted = false;

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

  /** Whether the phone has agent `agent`'s thread open on this socket (asked for it within ASSISTANT_FOLLOW_MS). */
  isFollowingAssistant(agent: string): boolean {
    const askedAt = this.assistantAskedAt.get(agent);
    return (
      this.phase.kind === "authenticated" &&
      askedAt !== undefined &&
      this.clock.now() - askedAt <= ASSISTANT_FOLLOW_MS
    );
  }

  /** Whether this socket asked for usage stats (`stats.get`), so it gets the pushed snapshots. */
  wantsStats(): boolean {
    return this.phase.kind === "authenticated" && this.statsWanted;
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

  /** Forwards a board write iff this socket sent `board.subscribe`. */
  boardChanged(delta: BoardDelta): void {
    if (this.phase.kind === "authenticated" && this.boardsSubscribed) this.sink.send(delta);
  }

  /** A session already blocked on an ask or a tool approval when the phone opens it still gets the card. */
  private replayPending(sessionId: string): void {
    const ask = this.deps.agents?.pendingAsk(sessionId) ?? null;
    if (ask !== null) this.agentAsk(sessionId, ask);
    const approval = this.deps.agents?.pendingApproval(sessionId) ?? null;
    if (approval !== null) this.agentApproval(sessionId, approval);
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

  /** Shows a pending tool approval iff subscribed to `sessionId`; the phone may approve or deny it. */
  agentApproval(sessionId: string, approval: AgentApproval): void {
    if (this.phase.kind !== "authenticated" || !this.subscriptions.has(sessionId)) return;
    this.sink.send({ t: "agent.approval", sessionId, approval });
  }

  /** Tells the phone a pending approval closed iff subscribed; it dismisses that card. */
  agentApprovalResolved(sessionId: string, id: string): void {
    if (this.phase.kind !== "authenticated" || !this.subscriptions.has(sessionId)) return;
    this.sink.send({ t: "agent.approval.resolved", sessionId, id });
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
    this.deps.calls?.drop(this.sink);
    this.deps.files?.drop(this.sink);
    this.deps.control?.drop(this.sink);
    this.deps.rooms?.drop(this.sink);
    this.deps.live?.drop(this.sink);
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
    // Tailscale already authenticated this peer as a device on Isaac's tailnet: no PIN.
    if (isTailnetAddress(this.deps.remoteAddress)) {
      this.issueSecret(phase.deviceId, phase.deviceName);
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
    this.deps.pairing.end();
    this.issueSecret(phase.deviceId, phase.deviceName);
  }

  private issueSecret(deviceId: string, deviceName: string): void {
    const secret = randomBytes(32);
    this.deps.devices.save(secret, deviceId, deviceName);
    this.sink.send({ t: "pair.ok", secret: toHex(secret) });
    this.authenticate(deviceId);
  }

  private handleAuthenticated(deviceId: string, message: ClientMessage): void {
    switch (message.t) {
      case "input":
        if (this.inputAllowed()) this.deps.input.handle(message.events);
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
            this.replayPending(sessionId);
          },
          () => {
            if (this.closed || this.subscriptions.get(sessionId) !== 0) return;
            this.sink.send({ t: "agent.conversation", sessionId, rev: 0, messages: [] });
            this.replayPending(sessionId);
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
      case "sessions.list":
        this.sink.send({ t: "sessions.list", files: this.deps.sessionFiles?.list() ?? [] });
        break;
      case "session.read": {
        const { profile, dir, parent, name, offset } = message;
        const chunk =
          this.deps.sessionFiles?.read(profile, dir, name, offset, message.limit, parent) ?? null;
        const echo = {
          ...(profile === undefined ? {} : { profile }),
          ...(parent === undefined ? {} : { parent }),
        };
        this.sink.send({
          t: "session.chunk",
          ...echo,
          dir,
          name,
          offset,
          data: chunk?.data ?? null,
          size: chunk?.size ?? 0,
        });
        break;
      }
      case "blob.read": {
        const blob = this.deps.sessionFiles?.blob(message.hash) ?? null;
        this.sink.send({
          t: "blob.data",
          hash: message.hash,
          mime: blob?.mime ?? null,
          data: blob?.data ?? null,
        });
        break;
      }
      case "push.register":
        this.deps.push?.register(deviceId, message.token);
        break;
      case "push.unregister":
        this.deps.push?.unregister(deviceId);
        break;
      case "push.prefs":
        this.deps.push?.setMuted(deviceId, message.muted);
        break;
      case "drop.list":
        this.sink.send({
          t: "drop.list",
          drops: this.deps.drops === null ? [] : [...this.deps.drops.list()],
        });
        break;
      case "board.subscribe":
        this.boardsSubscribed = true;
        this.sink.send(this.deps.boards?.snapshot() ?? { t: "board.snapshot", rev: 0, boards: [] });
        break;
      case "board.get":
        this.sink.send(this.deps.boards?.snapshot() ?? { t: "board.snapshot", rev: 0, boards: [] });
        break;
      case "gate.get":
        this.sink.send({ t: "gate.status", gate: this.deps.agents?.gate ?? null });
        break;
      case "usage.get":
        this.sink.send({
          t: "usage.snapshot",
          usage: this.deps.usage?.get() ?? { accounts: [], updatedAt: null, refreshing: false },
        });
        this.deps.usage?.refreshIfOld();
        break;
      case "usage.refresh":
        // The refreshing and finished snapshots arrive through the server's broadcast.
        if (this.deps.usage === null)
          this.sink.send({
            t: "usage.snapshot",
            usage: { accounts: [], updatedAt: null, refreshing: false },
          });
        else void this.deps.usage.refresh();
        break;
      case "stats.get":
        this.statsWanted = true;
        this.sink.send({
          t: "stats.snapshot",
          stats: this.deps.stats?.get() ?? { updatedAt: null, refreshing: false, profiles: [], ranges: null },
        });
        this.deps.stats?.refreshIfStale();
        break;
      case "catchup.list":
        this.sink.send({
          t: "catchup.snapshot",
          ...(this.deps.catchup?.snapshot() ?? EMPTY_CATCHUP),
        });
        break;
      case "catchup.mark":
      case "catchup.handoff":
      case "catchup.bounce": {
        const deck = this.deps.catchup;
        const changed =
          message.t === "catchup.mark"
            ? deck?.mark(message.id, message.read)
            : message.t === "catchup.handoff"
              ? deck?.handoff(message.id, message.agent, message.note)
              : deck?.bounce(message.id, message.agent, message.reason);
        // A change reaches every phone through the server's broadcast; otherwise this phone's optimistic deck is put right.
        if (changed !== true)
          this.sink.send({ t: "catchup.snapshot", ...(deck?.snapshot() ?? EMPTY_CATCHUP) });
        break;
      }
      case "catchup.note":
        this.sink.send({
          t: "catchup.noted",
          id: message.id,
          ok: this.deps.catchup?.note(message.id, message.text, message.signal) === true,
        });
        break;
      case "feed.list":
        this.sink.send({ t: "feed.snapshot", ...(this.deps.feed?.snapshot() ?? EMPTY_FEED) });
        break;
      case "feed.signal":
        this.deps.feed?.signal(message.id, message.action, message.title, message.source);
        break;
      case "reactions.get":
        this.sink.send({
          t: "reactions.snapshot",
          thread: message.thread,
          reactions: this.deps.reactions?.snapshot(message.thread) ?? {},
        });
        break;
      case "bookmarks.get":
        this.sink.send({ t: "bookmarks.snapshot", thread: message.thread, messages: [...(this.deps.bookmarks?.snapshot(message.thread) ?? [])] });
        break;
      case "bookmark.set": {
        const bookmarks = this.deps.bookmarks;
        // A change reaches every device (this one included) through the service; no change still answers this one, so its optimistic state settles.
        if (bookmarks === null || !bookmarks.set(message.thread, message.message, message.on))
          this.sink.send({ t: "bookmarks.snapshot", thread: message.thread, messages: [...(bookmarks?.snapshot(message.thread) ?? [])] });
        break;
      }
      case "reaction.set":
      case "reaction.clear": {
        const reactions = this.deps.reactions;
        const changed =
          reactions !== null &&
          (message.t === "reaction.set"
            ? reactions.set(message.thread, message.message, message.emoji, message.excerpt)
            : reactions.clear(message.thread, message.message));
        // A change reaches every device (this one included) through the service; no change still answers this one, so its optimistic state settles.
        if (!changed)
          this.sink.send({
            t: "reactions.snapshot",
            thread: message.thread,
            reactions: reactions?.snapshot(message.thread) ?? {},
          });
        break;
      }
      case "render.failed": {
        // Fire and forget: the service logs it and tells the bubble's agent; the device gets no answer.
        const { thread, message: key, kind, form, src, error, surface } = message;
        this.deps.renderFailures?.report({ thread, message: key, kind, form, src, error, surface }, { id: deviceId, name: this.deviceName ?? deviceId });
        break;
      }
      case "artifacts.get":
        // The service pushes the snapshot to every device, this one included.
        if (this.deps.artifacts === null)
          this.sink.send({
            t: "artifacts.snapshot",
            thread: message.thread,
            items: [],
            tabs: defaultTabs(),
          });
        else this.deps.artifacts.get(message.thread);
        break;
      case "activity.get":
        // The service pushes the list to every device, this one included.
        if (this.deps.activity === null) this.sink.send({ t: "activity.snapshot", items: [] });
        else this.deps.activity.get();
        break;
      case "artifacts.act": {
        const result = this.deps.artifacts?.act(message.thread, message.by, message.action) ?? {
          ok: false,
          error: "This host keeps no artifacts.",
        };
        this.sink.send({ t: "artifacts.acted", rid: message.rid, ...result });
        break;
      }
      case "assistant.get": {
        // An unknown agent, or no agent from an old phone on a host without threads, follows nothing.
        const thread = this.deps.assistant?.thread(message.agent);
        if (thread === undefined) {
          if (message.agent !== undefined)
            this.sink.send({
              t: "assistant.snapshot",
              agent: message.agent,
              snapshot: EMPTY_ASSISTANT,
            });
          break;
        }
        this.assistantAskedAt.set(thread.id, this.clock.now());
        // The thread is on screen and its Call button one tap away: start the speech models now.
        this.deps.calls?.warm();
        void thread.snapshot().then(
          (snapshot) => {
            if (!this.closed)
              this.sink.send({ t: "assistant.snapshot", agent: thread.id, snapshot });
          },
          () => {
            if (!this.closed)
              this.sink.send({
                t: "assistant.snapshot",
                agent: thread.id,
                snapshot: EMPTY_ASSISTANT,
              });
          },
        );
        break;
      }
      case "assistant.agents": {
        const assistant = this.deps.assistant;
        if (assistant === null) {
          this.sink.send({ t: "assistant.agents", agents: [] });
          break;
        }
        void assistant.agents().then((agents) => {
          if (!this.closed) this.sink.send({ t: "assistant.agents", agents });
        });
        break;
      }
      case "canvas.get":
        this.sink.send(this.deps.canvas?.snapshot() ?? { t: "canvas.rooms", rev: 0, rooms: [] });
        break;
      case "canvas.open":
        this.sink.send(
          this.deps.canvas?.open(message.slug, deviceId) ?? {
            t: "canvas.unavailable",
            slug: message.slug,
            reason: "This host runs no live canvas.",
          },
        );
        break;
      case "vnc.open":
        void this.deps.vnc.open(deviceId).then(
          (ticket) => {
            if (!this.closed)
              this.sink.send(
                ticket === null ? { t: "vnc.unavailable" } : { t: "vnc.ticket", ticket },
              );
          },
          () => {
            if (!this.closed) this.sink.send({ t: "vnc.unavailable" });
          },
        );
        break;
      case "inbox.item":
        this.deps.inbox?.item(deviceId, message.item);
        break;
      case "inbox.resolve":
        this.deps.inbox?.resolve(deviceId, message);
        break;
      case "call.start":
      case "call.audio":
      case "call.mute":
      case "call.end":
        if (this.deps.calls !== null) this.deps.calls.receive(this.sink, message);
        else if (message.t === "call.start")
          this.sink.send({
            t: "call.state",
            callId: message.callId,
            agent: message.agent,
            state: "ended",
            error: "This host cannot take calls",
          });
        break;
      case "live.start":
      case "live.end":
      case "live.resume":
        if (this.deps.live !== null) this.deps.live.receive(this.sink, message);
        else if (message.t !== "live.end")
          this.sink.send({
            t: "live.state",
            callId: message.callId,
            agent: message.agent,
            state: "ended",
            error: "This host cannot take live calls",
            ...(message.t === "live.start" ? { fallback: true } : {}),
          });
        break;
      case "studio.list":
        this.sink.send({
          t: "studio.state",
          ...(this.deps.studio?.state() ?? { jobs: [], uploads: [], backends: [], projects: [], references: [] }),
        });
        // A preset or model file dropped in since shows up on Studio's next open, without a Refresh.
        void this.deps.studio?.rescan();
        break;
      case "studio.req": {
        // Changes reach every device (this one included) through the service's broadcast; this is the answer.
        const studio = this.deps.studio;
        if (studio === null) {
          this.sink.send({
            t: "studio.res",
            rid: message.rid,
            ok: false,
            error: "This host runs no Studio.",
          });
          break;
        }
        void studio.handle(message.op).then((result) => {
          if (!this.closed) this.sink.send({ t: "studio.res", rid: message.rid, ...result });
        });
        break;
      }
      case "reviews.req": {
        // Queue and Astra changes reach every device through the service's broadcast; this is the answer.
        const reviews = this.deps.reviews;
        if (reviews === null) {
          this.sink.send({
            t: "reviews.res",
            rid: message.rid,
            ok: false,
            error: "This host runs no Reviews.",
          });
          break;
        }
        void reviews.handle(message.op).then((result) => {
          if (!this.closed) this.sink.send({ t: "reviews.res", rid: message.rid, ...result });
        });
        break;
      }
      case "meetings.list":
        this.sink.send({
          t: "meetings.state",
          ...(this.deps.meetings?.state() ?? {
            recordings: [],
            meetings: [],
            digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
            now: this.clock.now(),
          }),
        });
        break;
      case "meetings.req": {
        // Changes reach every device through the service's broadcast; this is the answer.
        const meetings = this.deps.meetings;
        if (meetings === null) {
          this.sink.send({
            t: "meetings.res",
            rid: message.rid,
            ok: false,
            error: "This host runs no Meetings.",
          });
          break;
        }
        void meetings.handle(message.op).then((result) => {
          if (!this.closed) this.sink.send({ t: "meetings.res", rid: message.rid, ...result });
        });
        break;
      }
      case "meeting.ingest.open": {
        const meetings = this.deps.meetings;
        const open = {
          id: message.id,
          app: message.app,
          title: message.title,
          startedAt: message.startedAt,
        };
        const r =
          meetings === null
            ? { refused: "This host runs no Meetings." }
            : meetings.openIngest(deviceId, this.deviceName ?? deviceId, open);
        this.sink.send(
          "ticket" in r
            ? { t: "meeting.ingest.ticket", id: message.id, ticket: r.ticket }
            : { t: "meeting.ingest.refused", id: message.id, reason: r.refused },
        );
        break;
      }
      case "assistant.file.req": {
        const assistant = this.deps.assistant;
        const result =
          assistant?.file === undefined
            ? { ok: false, code: "invalid" as const, error: "This host has no assistants." }
            : assistant.file(message);
        this.sink.send({ t: "assistant.file.res", rid: message.rid, ...result });
        break;
      }
      case "query.req": {
        const query = this.deps.query;
        if (query === null) {
          this.sink.send({
            t: "query.res",
            rid: message.rid,
            ok: false,
            error: "This host runs no queries.",
          });
          break;
        }
        void query.run(message.tool, message.args ?? {}, deviceId).then((answer) => {
          if (!this.closed) this.sink.send({ t: "query.res", rid: message.rid, ...answer });
        });
        break;
      }
      case "files.open":
        this.deps.files?.open(
          { sink: this.sink, device: deviceId, deviceName: this.name ?? deviceId },
          message.paths,
        );
        break;
      case "files.caret":
        this.deps.files?.caret(
          { sink: this.sink, device: deviceId, deviceName: this.name ?? deviceId },
          message.focus,
        );
        break;
      case "files.saved":
        this.deps.files?.saved(message.path, message.hash);
        break;
      case "control.presence":
        this.deps.control?.presence({ sink: this.sink, device: deviceId, loopback: isLoopback(this.deps.remoteAddress) }, message);
        break;
      case "control.res":
        this.deps.control?.result(this.sink, message.rid, message.result);
        break;
      case "rooms.sync":
        this.deps.rooms?.sync(this.sink, message.rooms);
        break;
      case "rooms.upsert":
        this.deps.rooms?.upsert(this.sink, message.room);
        break;
      case "rooms.res":
        this.deps.rooms?.result(this.sink, message.rid, message.result);
        break;
      case "rooms.get":
        this.deps.rooms?.get(this.sink, message.chat === true);
        break;
      case "rooms.cmd":
        this.deps.rooms?.cmd(this.sink, message.rid, message.cmd);
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

    void this.execute(id, cmd, deviceId).then((response) => {
      this.deps.dedup.complete(deviceId, id, response);
      // The waiter list never includes this sink; send to ourselves even if the socket closed
      // meanwhile (FrameSink.send after close is a no-op).
      this.sink.send(response);
    });
  }

  private async execute(id: string, cmd: Command, deviceId: string): Promise<ServerMessage> {
    try {
      await this.run(id, cmd, deviceId);
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

  /**
   * Runs `act`, which settles inbox item `id`, with the answer claimed first: omp's resolved event
   * can land before `act` returns, and the Mac's row must hear who answered. A failed answer
   * (Face ID missing, approval already gone) gives the claim back.
   */
  private claimed(
    id: string,
    deviceId: string,
    answer: string,
    act: () => Promise<void>,
  ): Promise<void> {
    const inbox = this.deps.inbox;
    if (inbox === null) return act();
    inbox.claim(id, deviceId, answer);
    try {
      return act().catch((error: unknown) => {
        inbox.release(id);
        throw error;
      });
    } catch (error) {
      inbox.release(id);
      throw error;
    }
  }

  /** Input needs the OS permission; the first refused use asks for it (never at startup). */
  private inputAllowed(): boolean {
    if (this.deps.access.granted) return true;
    this.deps.access.request?.();
    return false;
  }

  private run(id: string, cmd: Command, deviceId: string): Promise<void> {
    switch (cmd.kind) {
      case "text.insert":
        return this.inputAllowed()
          ? this.deps.text.insert(cmd.text)
          : Promise.reject(noInputDevice());
      case "key.press":
        return this.inputAllowed()
          ? this.deps.text.press(cmd.key)
          : Promise.reject(noInputDevice());
      case "clipboard.paste":
        return this.inputAllowed()
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
        return this.startAgent(id, cmd);
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
      case "agent.ask.answer": {
        const first = cmd.results[0];
        const answer = first?.selectedOptions[0] ?? first?.customInput ?? "Answered";
        return this.claimed(`ask:${cmd.askId}`, deviceId, answer, () =>
          this.agents().answerAsk(cmd.sessionId, cmd.askId, cmd.results),
        );
      }
      case "agent.ask.cancel":
        return this.agents().cancelAsk(cmd.sessionId, cmd.askId);
      case "agent.approve":
        return this.claimed(`approval:${cmd.approvalId}`, deviceId, "Approved", () =>
          this.agents().decideApproval(cmd.sessionId, cmd.approvalId, true, cmd.confirmed),
        );
      case "agent.deny":
        return this.claimed(`approval:${cmd.approvalId}`, deviceId, "Denied", () =>
          this.agents().decideApproval(cmd.sessionId, cmd.approvalId, false),
        );
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
      case "gate.start":
      case "gate.done":
      case "gate.override":
        if (this.deps.agents === null) {
          return Promise.reject(
            new AckFailure({
              code: "gate_unavailable",
              message: "this host has no agent bridge to reach the habit gate",
            }),
          );
        }
        return this.deps.agents.runGate(cmd);
      case "assistant.turn":
        if (cmd.text.length === 0 && cmd.images === undefined) {
          return Promise.reject(
            new AckFailure({
              code: "invalid_command",
              message: "turn has neither text nor images",
            }),
          );
        }
        return this.assistantThread(cmd.agent).turn(cmd.text, cmd.images);
      case "assistant.signin":
        return this.assistantThread(cmd.agent).signin(
          cmd.messageId,
          cmd.url,
          cmd.username,
          cmd.password,
        );
      case "assistant.ask.resolve": {
        // An id no longer open acks ok too: another device or the assistant closed it first.
        const thread = this.deps.assistant?.thread(cmd.agent);
        if (thread === undefined) {
          return Promise.reject(
            new AckFailure({
              code: "invalid_command",
              message: `no assistant ${cmd.agent} on this host`,
            }),
          );
        }
        thread.resolveAsk(cmd.id, cmd.how, cmd.answer);
        return Promise.resolve();
      }
      case "assistant.create": {
        const assistant = this.deps.assistant;
        if (assistant?.create === undefined) {
          return Promise.reject(
            new AckFailure({ code: "invalid_command", message: "this host cannot add assistants" }),
          );
        }
        const { id, title, scope } = cmd;
        return assistant
          .create(
            {
              title,
              ...(id === undefined ? {} : { id }),
              ...(scope === undefined ? {} : { scope }),
            },
            cmd.start === true,
          )
          .then(() => undefined);
      }
    }
  }

  /** Thread `agent` (the default when absent); throws `AckFailure` on a host without threads or for an unknown agent. */
  private assistantThread(agent: string | undefined): AssistantThread {
    const assistant = this.deps.assistant;
    if (assistant === null)
      throw new AckFailure({
        code: "agent_launch_failed",
        message: "this host has no assistant threads",
      });
    const thread = assistant.thread(agent);
    if (thread === undefined)
      throw new AckFailure({
        code: "agent_not_found",
        message: `no assistant ${agent ?? "(default)"} on this host`,
      });
    return thread;
  }

  /**
   * Launches (or, with `resume`, relaunches in its own profile) an omp session; resolves once it is
   * launched, and sends `agent.started` for request `id` when it joins. An unknown `resume` is refused.
   */
  private async startAgent(
    id: string,
    cmd: Extract<Command, { kind: "agent.start" }>,
  ): Promise<void> {
    let profile = cmd.profile;
    let file: string | undefined;
    if (cmd.resume !== undefined) {
      const found = this.deps.sessionFiles?.fileForSessionId(cmd.resume) ?? null;
      if (found === null)
        throw new AckFailure({
          code: "agent_not_found",
          message: `no omp session ${cmd.resume} on this host`,
        });
      if (found.profile !== undefined && found.profile !== "personal" && found.profile !== "work") {
        throw new AckFailure({
          code: "agent_launch_failed",
          message: `cannot resume sessions of omp profile ${found.profile}`,
        });
      }
      profile = found.profile;
      file = found.path;
    }
    const { joined } = await this.agents().launch(cmd.prompt, cmd.thinkingLevel, profile, file);
    void joined.then(
      (sessionId) => {
        if (!this.closed) this.sink.send({ t: "agent.started", id, sessionId });
      },
      // The launch was acked; a session that never joins has nothing to report.
      () => undefined,
    );
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
    const features = [
      ...(this.deps.query === null ? [] : [QUERY_FEATURE]),
      ...(this.deps.files === null ? [] : [FILES_PRESENCE_FEATURE]),
      ...(this.deps.meetings === null ? [] : [MEETINGS_FEATURE]),
      ...(this.deps.control === null ? [] : [CONTROL_FEATURE]),
      ...(this.deps.bookmarks === null ? [] : [BOOKMARKS_FEATURE]),
      ...(this.deps.stats === null ? [] : [STATS_FEATURE]),
      ...((this.deps.renderFailures ?? null) === null ? [] : [RENDER_REPORT_FEATURE]),
      ...((this.deps.rooms ?? null) === null ? [] : [ROOMS_FEATURE, ROOMS_RESUME_FEATURE, ROOMS_CHAT_FEATURE, ROOMS_DECIDE_FEATURE]),
      // Snapshots carry guest rows (another assistant popped into a thread) with their entry.
      ...(this.deps.assistant?.consult === undefined ? [] : [ASSISTANT_GUESTS_FEATURE]),
    ];
    this.sink.send({
      t: "welcome",
      state: this.snapshot(),
      ...(features.length === 0 ? {} : { features }),
    });
    // Items that opened while this device was away; the escalator itself is the one that sent them.
    if (deviceId !== ESCALATOR_DEVICE_ID) {
      for (const item of this.deps.inbox?.pending() ?? [])
        this.sink.send({ t: "inbox.item", item });
    }
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
    this.deps.calls?.drop(this.sink);
    this.deps.live?.drop(this.sink);
    this.deps.control?.drop(this.sink);
    this.deps.rooms?.drop(this.sink);
    this.closed = true;
    this.failure = `${code}: ${message}`;
    this.sink.send({ t: "error", code, message });
    this.sink.close();
    this.onClose(this);
  }
}

/** Tailscale assigns 100.64.0.0/10 (IPv4) and fd7a:115c:a1e0::/48 (IPv6); Bun may report IPv4 as `::ffff:`-mapped. */
export function isTailnetAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, "");
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4 !== null) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
