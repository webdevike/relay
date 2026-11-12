/**
 * Connection session statechart (XState v5): the phone-side mirror of the Mac's `ClientSession`
 * (apps/mac/Sources/RelayCore/Transport/ClientSession.swift), plus discovery, backoff, heartbeat
 * and the app going to the background on top. Pure: no sockets, no storage, no timers of its own.
 * Every side effect is an `effect` it emits (`SessionEffect`), which the driver (index.ts, through
 * the `SessionMachine` facade in session.ts) performs. The only ambient inputs are the injected
 * `random` seam, the `proof` actor the runtime provides, and the `now` (monotonic ms) carried by
 * `timer.fired` and `host.pong`.
 *
 *   idle -> discovering -> connecting -> hello -> authenticating -> connected
 *                                        hello -> pairing_request -> pairing_pin -> authenticating
 *   a live state losing its socket -> backoff -(timer)-> connecting; the app backgrounded -> offline
 *
 * Every move into `offline` or `backoff` tells the store, so the status never says "connected"
 * while the socket is closed.
 */
import { and, assertEvent, assign, emit, enqueueActions, fromPromise, not, or, setup, stateIn } from "xstate";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type MacState,
  type PairFailure,
  type ServerMessage,
} from "@relay/protocol";
import type { ConnectionState } from "@/state/connection";
import type { DiscoveredService } from "./discovery";

export type SessionState =
  | "idle"
  | "discovering"
  | "connecting"
  | "hello"
  | "needs_pairing"
  | "pairing_request"
  | "pairing_pin"
  | "authenticating"
  | "connected"
  | "backoff"
  | "offline";

type StoreUpdate = Partial<Omit<ConnectionState, "set">>;

export type SessionEffect =
  | { readonly type: "connect"; readonly host: string; readonly port: number }
  | { readonly type: "send"; readonly message: ClientMessage }
  | { readonly type: "startDiscovery" }
  | { readonly type: "stopDiscovery" }
  | { readonly type: "scheduleRetry"; readonly ms: number }
  | { readonly type: "storeSecret"; readonly hex: string }
  | { readonly type: "forgetSecret" }
  | { readonly type: "storeUpdate"; readonly partial: StoreUpdate };

export type SessionEvent =
  | { type: "socket.opened" }
  /** The socket in use ended (the driver drops the end of a socket a newer one already replaced). */
  | { type: "socket.closed" }
  | { type: "discovery.found"; service: DiscoveredService; pairedSecretHex: string | null }
  | { type: "app.active" }
  | { type: "app.background" }
  | { type: "pairing.start" }
  | { type: "pairing.pin"; pin: string }
  /** The one retry/heartbeat timer the driver runs (`scheduleRetry`) fired. */
  | { type: "timer.fired"; now: number }
  | { type: "host.challenge"; nonce: string }
  | { type: "host.unpaired" }
  | { type: "host.pairPending" }
  | { type: "host.pairOk"; secret: string }
  | { type: "host.pairFailed"; reason: PairFailure }
  | { type: "host.welcome"; mac: MacState }
  | { type: "host.error"; code: ErrorCode; message: string }
  | { type: "host.macState"; mac: MacState }
  | { type: "host.pong"; ts: number; now: number };

export interface SessionEmitted {
  type: "effect";
  effect: SessionEffect;
}

export interface SessionMachineInput {
  readonly deviceId: string;
  readonly getDeviceName: () => string;
  readonly random?: (() => number) | undefined;
}

export interface SessionContext {
  readonly deviceId: string;
  readonly getDeviceName: () => string;
  readonly random: () => number;
  secretHex: string | null;
  candidate: { host: string; port: number } | null;
  /** Reconnect attempts since the last welcome; picks the backoff delay. */
  attempts: number;
  /** The app is in the background; set until the next `app.active`. */
  backgrounded: boolean;
  awaitingPong: boolean;
  missedPongs: number;
  lastRttMs: number | null;
  lastPingTs: number | null;
}

export interface ProofInput {
  secretHex: string;
  nonce: string;
}

export const HEARTBEAT_INTERVAL_MS = 5000;
const BACKOFF_SCHEDULE_MS = [500, 1000, 2000, 4000, 5000] as const;

/** attempt 1 -> 0.5s, 2 -> 1s, 3 -> 2s, 4 -> 4s, 5+ -> capped 5s, all jittered by up to ±20%. */
function backoffDelay(attempt: number, random: () => number): number {
  const base = BACKOFF_SCHEDULE_MS[Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1)] ?? 5000;
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.round(base + jitter);
}

/** The session event a host frame is, or null for frames other routers own. */
export function sessionEventOf(message: ServerMessage, now: number): SessionEvent | null {
  if (message.t === "challenge") return { type: "host.challenge", nonce: message.nonce };
  if (message.t === "unpaired") return { type: "host.unpaired" };
  if (message.t === "pair.pending") return { type: "host.pairPending" };
  if (message.t === "pair.ok") return { type: "host.pairOk", secret: message.secret };
  if (message.t === "pair.failed") return { type: "host.pairFailed", reason: message.reason };
  if (message.t === "welcome") return { type: "host.welcome", mac: message.state.mac };
  if (message.t === "error") return { type: "host.error", code: message.code, message: message.message };
  if (message.t === "mac.state") return { type: "host.macState", mac: message.mac };
  if (message.t === "pong") return { type: "host.pong", ts: message.ts, now };
  // Agent, drop, board, call, rooms and every other frame go to their stores, and ack/nack to the
  // command queue, by index.ts.
  return null;
}

const PAIRING_ASKED: StoreUpdate = { status: "pairing", pairing: { pinRequired: false, failure: null } };

function effect(value: SessionEffect): SessionEmitted {
  return { type: "effect", effect: value };
}

export const sessionMachine = setup({
  types: {
    context: {} as SessionContext,
    events: {} as SessionEvent,
    emitted: {} as SessionEmitted,
    input: {} as SessionMachineInput,
  },
  actors: {
    /** The HMAC answer to the host's challenge from the paired secret (`authProof`, provided by session.ts). */
    proof: fromPromise<string, ProofInput>(() => {
      throw new Error('session actor "proof" not provided');
    }),
  },
  guards: {
    backgrounded: ({ context }) => context.backgrounded,
    noCandidate: ({ context }) => context.candidate === null,
    hasSecret: ({ context }) => context.secretHex !== null,
    /** Nothing was connected (or the host refused this app): a closed socket changes nothing. */
    atRest: or([stateIn("idle"), stateIn("offline"), stateIn("discovering"), stateIn("needs_pairing")]),
    inBackoff: stateIn("backoff"),
    wasDiscovering: stateIn("discovering"),
    inIdle: stateIn("idle"),
    validPin: ({ event }) => event.type === "pairing.pin" && /^\d{6}$/.test(event.pin),
    wrongPin: ({ event }) => event.type === "host.pairFailed" && event.reason === "wrong_pin",
    credentialRejected: ({ event }) =>
      event.type === "host.error" && (event.code === "unknown_device" || event.code === "auth_failed"),
    hostBusy: ({ event }) => event.type === "host.error" && event.code === "busy",
    /** This tick finds a ping unanswered for the second time in a row. */
    heartbeatLost: ({ context }) => context.awaitingPong && context.missedPongs + 1 >= 2,
    answersLastPing: ({ context, event }) => event.type === "host.pong" && event.ts === context.lastPingTs,
    /** The app is in the background and still thought it had a connection (a busy host's retry). */
    closedInBackground: and([({ context }) => context.backgrounded, not(stateIn("offline"))]),
    /** Busy again while already backing off: the same attempt, not a new one. */
    busyInBackoff: and([({ event }) => event.type === "host.error" && event.code === "busy", stateIn("backoff")]),
  },
  actions: {
    resetPong: assign({ awaitingPong: false, missedPongs: 0 }),
    resetPing: assign({ awaitingPong: false, missedPongs: 0, lastPingTs: null }),
    countAttempt: assign({ attempts: ({ context }) => context.attempts + 1 }),
    goBackground: assign({ backgrounded: true }),
    emitOffline: emit(effect({ type: "storeUpdate", partial: { status: "offline" } })),
    emitStopDiscovery: emit(effect({ type: "stopDiscovery" })),
    emitDiscovering: enqueueActions(({ enqueue }) => {
      enqueue.emit(effect({ type: "storeUpdate", partial: { status: "discovering" } }));
      enqueue.emit(effect({ type: "startDiscovery" }));
    }),
    emitConnect: enqueueActions(({ context, enqueue }) => {
      if (context.candidate === null) return;
      enqueue.emit(effect({ type: "storeUpdate", partial: { status: "connecting" } }));
      enqueue.emit(effect({ type: "connect", host: context.candidate.host, port: context.candidate.port }));
    }),
    emitBackoff: enqueueActions(({ context, enqueue }) => {
      enqueue.emit(effect({ type: "storeUpdate", partial: { status: "reconnecting" } }));
      enqueue.emit(effect({ type: "scheduleRetry", ms: backoffDelay(context.attempts, context.random) }));
    }),
    emitPairRequest: enqueueActions(({ enqueue }) => {
      enqueue.emit(effect({ type: "send", message: { t: "pair.request" } }));
      enqueue.emit(effect({ type: "storeUpdate", partial: PAIRING_ASKED }));
    }),
    /** `pair.ok`: keep the secret; only `storeSecret`, so no status update races its write to Keychain. */
    savePairing: enqueueActions(({ event, enqueue }) => {
      assertEvent(event, "host.pairOk");
      enqueue.assign({ secretHex: event.secret });
      enqueue.emit(effect({ type: "storeSecret", hex: event.secret }));
    }),
  },
}).createMachine({
  id: "session",
  initial: "idle",
  context: ({ input }) => ({
    deviceId: input.deviceId,
    getDeviceName: input.getDeviceName,
    random: input.random ?? Math.random,
    secretHex: null,
    candidate: null,
    attempts: 0,
    backgrounded: false,
    awaitingPong: false,
    missedPongs: 0,
    lastRttMs: null,
    lastPingTs: null,
  }),
  on: {
    "app.active": [
      { guard: "backgrounded", target: ".starting", actions: assign({ backgrounded: false }) },
      { guard: "inIdle", target: ".starting" },
    ],
    "app.background": [
      {
        guard: "wasDiscovering",
        target: ".offline",
        actions: ["goBackground", "resetPing", "emitStopDiscovery", "emitOffline"],
      },
      { target: ".offline", actions: ["goBackground", "resetPing", "emitOffline"] },
    ],
    "socket.closed": [
      { guard: "closedInBackground", target: ".offline", actions: ["resetPong", "emitOffline"] },
      { guard: "atRest", actions: "resetPong" },
      // Already recovering (the close that always follows an error frame that put it here): the
      // same attempt again, not a new one.
      { guard: "inBackoff", actions: ["resetPing", "emitBackoff"] },
      { target: ".lost" },
    ],
    "host.error": [
      {
        guard: "credentialRejected",
        target: ".needs_pairing",
        actions: [
          assign({ secretHex: null }),
          emit(effect({ type: "forgetSecret" })),
          emit(effect({ type: "storeUpdate", partial: { ...PAIRING_ASKED, mac: null, macName: null } })),
        ],
      },
      { guard: "busyInBackoff", actions: ["resetPing", "emitBackoff"] },
      { guard: "hostBusy", target: ".lost" },
      {
        target: ".offline",
        actions: emit(({ event }) => {
          assertEvent(event, "host.error");
          return effect({ type: "storeUpdate", partial: { status: "offline", lastError: event.message } });
        }),
      },
    ],
  },
  states: {
    idle: {},
    /** Transient: connect to the known host, or discover one when none was found yet. */
    starting: {
      always: [
        { guard: "noCandidate", target: "discovering", actions: "emitDiscovering" },
        { target: "connecting", actions: "emitConnect" },
      ],
    },
    /** Transient: the socket of a live state went away; reconnect after a delay. */
    lost: {
      always: [
        { guard: "noCandidate", target: "discovering", actions: ["resetPing", "emitDiscovering"] },
        { target: "backoff", actions: ["resetPing", "countAttempt", "emitBackoff"] },
      ],
    },
    discovering: {
      on: {
        "discovery.found": {
          target: "connecting",
          actions: enqueueActions(({ event, enqueue }) => {
            assertEvent(event, "discovery.found");
            const { service } = event;
            enqueue.assign({ candidate: { host: service.host, port: service.port }, secretHex: event.pairedSecretHex });
            enqueue.emit(effect({ type: "stopDiscovery" }));
            enqueue.emit(effect({ type: "storeUpdate", partial: { status: "connecting", macName: service.name } }));
            enqueue.emit(effect({ type: "connect", host: service.host, port: service.port }));
          }),
        },
      },
    },
    connecting: {
      on: {
        "socket.opened": {
          target: "hello",
          actions: emit(({ context }) =>
            effect({
              type: "send",
              message: {
                t: "hello",
                v: PROTOCOL_VERSION,
                deviceId: context.deviceId,
                deviceName: context.getDeviceName(),
                platform: "ios",
              },
            }),
          ),
        },
      },
    },
    hello: {
      on: {
        "host.challenge": { guard: "hasSecret", target: "authenticating.proving" },
        // Always asks: a tailnet host answers `pair.ok` straight away, any other host shows a PIN.
        "host.unpaired": { target: "pairing_request", actions: "emitPairRequest" },
        "pairing.start": { target: "pairing_request", actions: "emitPairRequest" },
      },
    },
    needs_pairing: {
      on: { "pairing.start": { target: "starting" } },
    },
    pairing_request: {
      on: {
        "host.pairPending": {
          target: "pairing_pin",
          actions: emit(effect({ type: "storeUpdate", partial: { status: "pairing", pairing: { pinRequired: true, failure: null } } })),
        },
        "host.pairOk": { target: "authenticating", actions: "savePairing" },
      },
    },
    pairing_pin: {
      on: {
        "pairing.pin": {
          guard: "validPin",
          actions: emit(({ event }) => {
            assertEvent(event, "pairing.pin");
            return effect({ type: "send", message: { t: "pair.confirm", pin: event.pin } });
          }),
        },
        "host.pairOk": { target: "authenticating", actions: "savePairing" },
        "host.pairFailed": [
          {
            guard: "wrongPin",
            actions: emit(effect({ type: "storeUpdate", partial: { pairing: { pinRequired: true, failure: "wrong_pin" } } })),
          },
          {
            target: "hello",
            actions: emit(({ event }) => {
              assertEvent(event, "host.pairFailed");
              return effect({
                type: "storeUpdate",
                partial: { status: "pairing", pairing: { pinRequired: false, failure: event.reason } },
              });
            }),
          },
        ],
      },
    },
    authenticating: {
      initial: "waiting",
      on: {
        "host.welcome": {
          target: "connected",
          actions: [
            assign({ attempts: 0 }),
            "resetPing",
            emit(({ event }) => {
              assertEvent(event, "host.welcome");
              return effect({
                type: "storeUpdate",
                partial: {
                  status: "connected",
                  mac: event.mac,
                  macName: event.mac.name,
                  lastError: null,
                  pairing: { pinRequired: false, failure: null },
                },
              });
            }),
            emit(effect({ type: "scheduleRetry", ms: HEARTBEAT_INTERVAL_MS })),
          ],
        },
      },
      states: {
        waiting: {},
        proving: {
          tags: ["proving"],
          invoke: {
            src: "proof",
            input: ({ context, event }) => {
              assertEvent(event, "host.challenge");
              return { secretHex: context.secretHex ?? "", nonce: event.nonce };
            },
            onDone: {
              target: "waiting",
              actions: emit(({ event }) => effect({ type: "send", message: { t: "auth", proof: event.output } })),
            },
            // No proof, no answer: the host gives up on the socket and closes it, which backs off.
            onError: { target: "waiting" },
          },
        },
      },
    },
    connected: {
      on: {
        "host.macState": {
          actions: emit(({ event }) => {
            assertEvent(event, "host.macState");
            return effect({ type: "storeUpdate", partial: { mac: event.mac, macName: event.mac.name } });
          }),
        },
        "host.pong": {
          guard: "answersLastPing",
          actions: enqueueActions(({ event, enqueue }) => {
            assertEvent(event, "host.pong");
            enqueue.assign({ awaitingPong: false, missedPongs: 0, lastRttMs: event.now - event.ts });
          }),
        },
        "timer.fired": [
          { guard: "heartbeatLost", target: "lost" },
          {
            actions: enqueueActions(({ context, event, enqueue }) => {
              assertEvent(event, "timer.fired");
              enqueue.assign({
                missedPongs: context.missedPongs + (context.awaitingPong ? 1 : 0),
                awaitingPong: true,
                lastPingTs: event.now,
              });
              enqueue.emit(effect({ type: "send", message: { t: "ping", ts: event.now } }));
              enqueue.emit(effect({ type: "scheduleRetry", ms: HEARTBEAT_INTERVAL_MS }));
            }),
          },
        ],
      },
    },
    backoff: {
      on: { "timer.fired": { target: "starting" } },
    },
    offline: {},
  },
});
