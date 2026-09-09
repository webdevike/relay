/**
 * Phone-side mirror of the Mac's `ClientSession` state machine (see
 * apps/mac/Sources/RelayCore/Transport/ClientSession.swift), plus discovery/backoff/heartbeat on
 * top. Pure: no sockets, no storage, no timers. `handle` maps one input to the effects the driver
 * (index.ts) must perform; the only ambient inputs are the injected `sha256`/`random` seams and
 * the `now` (monotonic ms) passed into every call, so every transition is deterministic and
 * testable without React Native, real time, or a real connection.
 */
import { authProof, PROTOCOL_VERSION, type ClientMessage, type ErrorCode, type MacState, type PairFailure, type ServerMessage, type Sha256 } from "@relay/protocol";
import type { ConnectionState } from "@/state/connection";
import type { DiscoveredService } from "./discovery";

export type SessionState =
  | "idle"
  | "discovering"
  | "connecting"
  | "hello"
  | "pairing_request"
  | "pairing_pin"
  | "authenticating"
  | "connected"
  | "backoff"
  | "offline";

export type SessionInput =
  | { readonly type: "server"; readonly message: ServerMessage }
  | { readonly type: "socketOpen" }
  | { readonly type: "socketClosed" }
  | { readonly type: "serviceFound"; readonly service: DiscoveredService }
  | { readonly type: "appActive" }
  | { readonly type: "appBackground" }
  | { readonly type: "startPairing" }
  | { readonly type: "pinEntered"; readonly pin: string }
  | { readonly type: "timer" };

type StoreUpdate = Partial<Omit<ConnectionState, "set">>;

export type Effect =
  | { readonly type: "connect"; readonly host: string; readonly port: number }
  | { readonly type: "send"; readonly message: ClientMessage }
  | { readonly type: "startDiscovery" }
  | { readonly type: "stopDiscovery" }
  | { readonly type: "scheduleRetry"; readonly ms: number }
  | { readonly type: "storeSecret"; readonly hex: string }
  | { readonly type: "forgetSecret" }
  | { readonly type: "storeUpdate"; readonly partial: StoreUpdate };

export interface SessionDeps {
  readonly sha256: Sha256;
  readonly deviceId: string;
  readonly getDeviceName: () => string;
  readonly pairedSecretHex: string | null;
  readonly random?: () => number;
}

const HEARTBEAT_INTERVAL_MS = 5000;
const BACKOFF_SCHEDULE_MS = [500, 1000, 2000, 4000, 5000] as const;

/** attempt 1 -> 0.5s, 2 -> 1s, 3 -> 2s, 4 -> 4s, 5+ -> capped 5s, all jittered by up to ±20%. */
function backoffDelay(attempt: number, random: () => number): number {
  const base = BACKOFF_SCHEDULE_MS[Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1)] ?? 5000;
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.round(base + jitter);
}

export class SessionMachine {
  private state: SessionState = "idle";
  private secretHex: string | null;
  private candidate: { host: string; port: number } | null = null;
  private attempts = 0;
  private backgrounded = false;
  private awaitingPong = false;
  private missedPongs = 0;
  private lastRttMs: number | null = null;
  private readonly deps: SessionDeps;
  private readonly random: () => number;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.secretHex = deps.pairedSecretHex;
    this.random = deps.random ?? Math.random;
  }

  get currentState(): SessionState {
    return this.state;
  }

  get rttMs(): number | null {
    return this.lastRttMs;
  }

  async handle(input: SessionInput, now: number): Promise<Effect[]> {
    switch (input.type) {
      case "server":
        return this.onServerMessage(input.message, now);
      case "socketOpen":
        return this.onSocketOpen();
      case "socketClosed":
        return this.onSocketClosed();
      case "serviceFound":
        return this.onServiceFound(input.service);
      case "appActive":
        return this.onAppActive();
      case "appBackground":
        return this.onAppBackground();
      case "startPairing":
        return this.onStartPairing();
      case "pinEntered":
        return this.onPinEntered(input.pin);
      case "timer":
        return this.onTimer(now);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Local events
  // ---------------------------------------------------------------------------------------------

  private onSocketOpen(): Effect[] {
    if (this.state !== "connecting") return [];
    this.state = "hello";
    return [
      {
        type: "send",
        message: {
          t: "hello",
          v: PROTOCOL_VERSION,
          deviceId: this.deps.deviceId,
          deviceName: this.deps.getDeviceName(),
          platform: "ios",
        },
      },
    ];
  }

  private onSocketClosed(): Effect[] {
    this.awaitingPong = false;
    this.missedPongs = 0;
    if (this.backgrounded) {
      this.state = "offline";
      return [];
    }
    if (this.state === "idle" || this.state === "offline" || this.state === "discovering") return [];
    return this.enterBackoff();
  }

  private onServiceFound(service: DiscoveredService): Effect[] {
    if (this.state !== "discovering") return [];
    this.candidate = { host: service.host, port: service.port };
    this.state = "connecting";
    return [
      { type: "stopDiscovery" },
      { type: "storeUpdate", partial: { status: "connecting", macName: service.name } },
      { type: "connect", host: service.host, port: service.port },
    ];
  }

  private onAppActive(): Effect[] {
    const resuming = this.backgrounded;
    this.backgrounded = false;
    if (!resuming && this.state !== "idle") return [];
    return this.beginConnect();
  }

  private onAppBackground(): Effect[] {
    this.backgrounded = true;
    this.awaitingPong = false;
    this.missedPongs = 0;
    const effects: Effect[] = this.state === "discovering" ? [{ type: "stopDiscovery" }] : [];
    this.state = "offline";
    return effects;
  }

  private onStartPairing(): Effect[] {
    if (this.state !== "hello") return [];
    this.state = "pairing_request";
    return [
      { type: "send", message: { t: "pair.request" } },
      { type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: null } } },
    ];
  }

  private onPinEntered(pin: string): Effect[] {
    if (this.state !== "pairing_pin" || !/^\d{6}$/.test(pin)) return [];
    return [{ type: "send", message: { t: "pair.confirm", pin } }];
  }

  private onTimer(now: number): Effect[] {
    if (this.state === "backoff") return this.beginConnect();
    if (this.state === "connected") return this.heartbeatTick(now);
    return [];
  }

  // ---------------------------------------------------------------------------------------------
  // Server messages
  // ---------------------------------------------------------------------------------------------

  private async onServerMessage(message: ServerMessage, now: number): Promise<Effect[]> {
    switch (message.t) {
      case "challenge":
        return this.onChallenge(message.nonce);
      case "unpaired":
        return this.onUnpaired();
      case "pair.pending":
        return this.onPairPending();
      case "pair.ok":
        return this.onPairOk(message.secret);
      case "pair.failed":
        return this.onPairFailed(message.reason);
      case "welcome":
        return this.onWelcome(message.state.mac);
      case "error":
        return this.onErrorMessage(message.code, message.message);
      case "mac.state":
        return this.onMacState(message.mac);
      case "pong":
        return this.onPong(message.ts, now);
      case "agents.snapshot":
      case "agents.delta":
      case "agent.conversation":
      case "agent.messages":
      case "ack":
      case "nack":
        // Coding-agents feature is deferred; ack/nack are routed to CommandQueue by index.ts.
        return [];
    }
  }

  private async onChallenge(nonce: string): Promise<Effect[]> {
    if (this.state !== "hello" || this.secretHex === null) return [];
    this.state = "authenticating";
    const proof = await authProof(this.secretHex, nonce, this.deps.sha256);
    return [{ type: "send", message: { t: "auth", proof } }];
  }

  private onUnpaired(): Effect[] {
    if (this.state !== "hello") return [];
    return [{ type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: null } } }];
  }

  private onPairPending(): Effect[] {
    if (this.state !== "pairing_request") return [];
    this.state = "pairing_pin";
    return [{ type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: true, failure: null } } }];
  }

  private onPairOk(secret: string): Effect[] {
    if (this.state !== "pairing_pin") return [];
    this.secretHex = secret;
    this.state = "authenticating";
    return [{ type: "storeSecret", hex: secret }];
  }

  private onPairFailed(reason: PairFailure): Effect[] {
    if (this.state !== "pairing_pin") return [];
    if (reason === "wrong_pin") {
      return [{ type: "storeUpdate", partial: { pairing: { pinRequired: true, failure: "wrong_pin" } } }];
    }
    this.state = "hello";
    return [{ type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: reason } } }];
  }

  private onWelcome(mac: MacState): Effect[] {
    if (this.state !== "authenticating") return [];
    this.state = "connected";
    this.attempts = 0;
    this.awaitingPong = false;
    this.missedPongs = 0;
    return [
      {
        type: "storeUpdate",
        partial: { status: "connected", mac, macName: mac.name, lastError: null, pairing: { pinRequired: false, failure: null } },
      },
      { type: "scheduleRetry", ms: HEARTBEAT_INTERVAL_MS },
    ];
  }

  private onErrorMessage(code: ErrorCode, message: string): Effect[] {
    switch (code) {
      case "unknown_device":
        this.secretHex = null;
        this.state = "hello";
        return [
          { type: "forgetSecret" },
          { type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: false, failure: null }, mac: null, macName: null } },
        ];
      case "busy":
        return this.enterBackoff();
      case "version_mismatch":
      case "auth_failed":
      case "protocol":
        this.state = "offline";
        return [{ type: "storeUpdate", partial: { status: "offline", lastError: message } }];
    }
  }

  private onMacState(mac: MacState): Effect[] {
    if (this.state !== "connected") return [];
    return [{ type: "storeUpdate", partial: { mac, macName: mac.name } }];
  }

  private onPong(ts: number, now: number): Effect[] {
    if (this.state !== "connected") return [];
    this.awaitingPong = false;
    this.missedPongs = 0;
    this.lastRttMs = now - ts;
    return [];
  }

  // ---------------------------------------------------------------------------------------------
  // Shared transitions
  // ---------------------------------------------------------------------------------------------

  /** Connect to the known candidate, or fall back to discovery when none has been found yet. */
  private beginConnect(): Effect[] {
    if (this.candidate === null) {
      this.state = "discovering";
      return [{ type: "storeUpdate", partial: { status: "discovering" } }, { type: "startDiscovery" }];
    }
    this.state = "connecting";
    return [
      { type: "storeUpdate", partial: { status: "connecting" } },
      { type: "connect", host: this.candidate.host, port: this.candidate.port },
    ];
  }

  private enterBackoff(): Effect[] {
    this.awaitingPong = false;
    this.missedPongs = 0;
    if (this.candidate === null) {
      this.state = "discovering";
      return [{ type: "storeUpdate", partial: { status: "discovering" } }, { type: "startDiscovery" }];
    }
    this.attempts += 1;
    this.state = "backoff";
    return [
      { type: "storeUpdate", partial: { status: "reconnecting" } },
      { type: "scheduleRetry", ms: backoffDelay(this.attempts, this.random) },
    ];
  }

  private heartbeatTick(now: number): Effect[] {
    if (this.awaitingPong) {
      this.missedPongs += 1;
      if (this.missedPongs >= 2) return this.enterBackoff();
    }
    this.awaitingPong = true;
    return [
      { type: "send", message: { t: "ping", ts: now } },
      { type: "scheduleRetry", ms: HEARTBEAT_INTERVAL_MS },
    ];
  }
}
