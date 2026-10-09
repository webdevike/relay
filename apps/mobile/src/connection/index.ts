/**
 * Wires the pure pieces (SessionMachine, CommandQueue, Discovery, RelaySocket, identity) into the
 * live seams the rest of the app calls: `sendInput`/`sendCommand`/`getClientTime`/`connection`,
 * plus `@/state/actions` and `@/state/connection`. This is the only module in the package that
 * touches React Native runtime APIs (WebSocket, AppState, SecureStore, Zeroconf).
 */
import { useEffect } from "react";
import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { encode, parseServerMessage, WS_PATH, type Command, type InputEvent } from "@relay/protocol";
import { useConnectionStore } from "@/state/connection";
import { useAgentsStore } from "@/state/agents";
import { useDropsStore } from "@/state/drops";
import { setActions } from "@/state/actions";
import { useSettingsStore } from "@/state/settings";
import { createAgentFrameRouter } from "./agents";
import { createDropFrameRouter } from "./drops";
import * as identity from "./identity";
import { Discovery, type DiscoveredService } from "./discovery";
import { NO_HOSTS, removeHost, upsertHost, type PairedHosts } from "./hosts";
import { parseManualHost } from "./manual-host";
import { RelaySocket } from "./socket";
import { SessionMachine, type Effect } from "./session";
import { CommandQueue } from "./commands";
import { debug, warn } from "./log";

let started = false;
let deviceId = "";
let hosts: PairedHosts = NO_HOSTS;
/**
 * Id of the host the session aims at: a saved host, or one being paired from the host picker.
 * `null` only with no saved hosts, when discovery takes the first host it finds.
 */
let target: string | null = null;
let currentCandidate: DiscoveredService | null = null;
let machine: SessionMachine | null = null;
let wasActive = true;
let appStateSubscription: NativeEventSubscription | null = null;
let retryTimer: number | undefined;
/**
 * `host:port` the socket was last opened with (IPv6 bracketed), the origin for `/drops/...` blob
 * fetches. Only meaningful while `status === "connected"`; a later connect overwrites it.
 */
let hostAuthority: string | null = null;

const commandQueue = new CommandQueue();
const socket = new RelaySocket();
/** Image fetches sent and not yet answered; the host's `agent.image` (or a new welcome) clears them. */
const imagesInFlight = new Set<string>();

function imageKey(sessionId: string, id: string): string {
  return `${sessionId}/${id}`;
}

const routeAgentFrame = createAgentFrameRouter(useAgentsStore.getState(), (message) => socket.send(encode(message)));
const routeDropFrame = createDropFrameRouter(useDropsStore.getState());
const discovery = new Discovery({
  onCandidate: (service) => {
    currentCandidate = service;
    const pairedSecretHex = hosts.hosts.find((host) => host.id === (target ?? service.name))?.secretHex ?? null;
    void dispatch({ type: "serviceFound", service, pairedSecretHex });
  },
  onServices: (services) => {
    useConnectionStore.getState().set({ discovered: services });
  },
});

socket.onOpen = () => {
  void dispatch({ type: "socketOpen" });
};
socket.onClose = () => {
  void dispatch({ type: "socketClosed" });
};
socket.onError = (error) => {
  warn("socket", "error", error);
};
socket.onMessage = (data) => {
  const result = parseServerMessage(data);
  if (!result.ok) {
    warn("socket", "malformed server message", result.error);
    return;
  }
  const message = result.value;
  if (message.t === "ack") {
    commandQueue.onAck(message.id);
    return;
  }
  if (message.t === "nack") {
    commandQueue.onNack(message.id, message.error);
    return;
  }
  if (message.t === "welcome") {
    commandQueue.onReconnect((m) => socket.send(encode(m)));
    imagesInFlight.clear();
    // The host owns the drop history; the phone never trusts its copy across a (re)connection.
    socket.send(encode({ t: "drop.list" }));
  }
  if (message.t === "agent.image") imagesInFlight.delete(imageKey(message.sessionId, message.id));
  routeAgentFrame(message);
  routeDropFrame(message);
  void dispatch({ type: "server", message });
};

async function dispatch(input: Parameters<SessionMachine["handle"]>[0]): Promise<void> {
  if (machine === null) return;
  const effects = await machine.handle(input, getClientTime());
  await applyEffects(effects);
}

async function applyEffects(effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case "connect":
        debug("session", "connect", effect.host, effect.port);
        hostAuthority = `${effect.host.includes(":") ? `[${effect.host}]` : effect.host}:${effect.port}`;
        socket.open(`ws://${hostAuthority}${WS_PATH}`);
        break;
      case "send":
        socket.send(encode(effect.message));
        break;
      case "startDiscovery": {
        // A typed `host:port` target skips Bonjour entirely: hand the machine a synthetic resolved service.
        const manual = target === null ? null : parseManualHost(target);
        if (manual === null) {
          discovery.start(target);
        } else {
          discovery.stop();
          currentCandidate = manual;
          void dispatch({ type: "serviceFound", service: manual, pairedSecretHex: hosts.hosts.find((host) => host.id === target)?.secretHex ?? null });
        }
        break;
      }
      case "stopDiscovery":
        discovery.stop();
        break;
      case "scheduleRetry":
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void dispatch({ type: "timer" });
        }, effect.ms);
        break;
      case "storeSecret": {
        // With no target (nothing saved yet) the pairing belongs to whichever host discovery found.
        const id = target ?? currentCandidate?.name ?? null;
        if (id === null) break;
        target = id;
        const name = hosts.hosts.find((host) => host.id === id)?.name ?? currentCandidate?.name ?? id;
        await persistHosts({ ...upsertHost(hosts, { id, name, address: hostAuthority ?? "", secretHex: effect.hex }), activeId: id });
        break;
      }
      case "forgetSecret":
        // The target host no longer knows this phone: its saved secret is dead.
        if (target !== null) await persistHosts(removeHost(hosts, target));
        break;
      case "storeUpdate": {
        useConnectionStore.getState().set(effect.partial);
        // Keep the saved entry's name and address current with what the host reports on welcome.
        const saved = hosts.hosts.find((host) => host.id === target);
        const mac = effect.partial.mac;
        if (saved !== undefined && mac !== undefined && mac !== null && (mac.name !== saved.name || (hostAuthority ?? "") !== saved.address)) {
          await persistHosts(upsertHost(hosts, { ...saved, name: mac.name, address: hostAuthority ?? "" }));
        }
        break;
      }
    }
  }
}

/**
 * `Sha256`'s `Uint8Array` may be backed by `ArrayBufferLike` (TS 5.7+ generic typed arrays);
 * `expo-crypto`'s `digest` requires a plain `ArrayBuffer`-backed view, so reallocate to normalize.
 */
function sha256(data: Uint8Array): Promise<ArrayBuffer> {
  return digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(data));
}

/** Saves `next` to Keychain and publishes it, secrets stripped, to `useConnectionStore`. */
async function persistHosts(next: PairedHosts): Promise<void> {
  hosts = next;
  publishHosts();
  await identity.savePairedHosts(next);
}

function publishHosts(): void {
  useConnectionStore.getState().set({
    hosts: hosts.hosts.map((host) => ({ id: host.id, name: host.name, address: host.address })),
    activeHostId: target,
  });
}

async function boot(): Promise<void> {
  deviceId = await identity.getDeviceId();
  await identity.importProvisionedHost(deviceId);
  hosts = await identity.loadPairedHosts();
  target = hosts.activeId;
  publishHosts();
  wasActive = AppState.currentState === "active";
  appStateSubscription = AppState.addEventListener("change", onAppStateChange);
  await resetSession();
}

/** Tears down socket, timers and discovery, then starts a fresh machine aimed at `target`. */
async function resetSession(): Promise<void> {
  currentCandidate = null;
  discovery.stop();
  socket.close();
  clearTimeout(retryTimer);
  retryTimer = undefined;
  useConnectionStore.getState().set({
    status: "idle",
    mac: null,
    macName: null,
    lastError: null,
    pairing: { pinRequired: false, failure: null },
  });
  machine = new SessionMachine({
    sha256,
    deviceId,
    getDeviceName: () => useSettingsStore.getState().deviceName,
  });
  await dispatch({ type: "appActive" });
}

/**
 * Points the session at `id` (or discovery, for `null`). Everything the previous host said goes
 * with it, and commands still waiting for its ack are cancelled rather than replayed on the new one.
 */
async function retarget(id: string | null): Promise<void> {
  target = id;
  publishHosts();
  commandQueue.cancelAll();
  useAgentsStore.getState().applyWelcome(0, []);
  useDropsStore.getState().setAll([]);
  await resetSession();
}

/** A saved host connects with its secret; any other id starts pairing with it straight away. */
async function switchHost(id: string): Promise<void> {
  if (id === target && useConnectionStore.getState().status === "connected") return;
  const saved = hosts.hosts.some((host) => host.id === id);
  if (saved) await persistHosts({ ...hosts, activeId: id });
  await retarget(id);
  if (!saved) await dispatch({ type: "startPairing" });
}

async function forgetHost(id: string): Promise<void> {
  const next = removeHost(hosts, id);
  await persistHosts(next);
  if (id === target) await retarget(next.activeId);
}

function onAppStateChange(next: AppStateStatus): void {
  const active = next === "active";
  if (active === wasActive) return;
  wasActive = active;
  if (active) {
    void dispatch({ type: "appActive" });
    return;
  }
  void dispatch({ type: "appBackground" });
  socket.close();
}

/** Ephemeral; no-op unless `status === "connected"`, and never queued. */
export function sendInput(events: InputEvent[]): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "input", events }));
}

/** Ephemeral, like `sendInput`: the host drops subscriptions with the socket, so nothing is queued. */
export function subscribeAgent(sessionId: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "agent.subscribe", sessionId }));
}

export function unsubscribeAgent(sessionId: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "agent.unsubscribe", sessionId }));
}

/** Ephemeral; the answer lands in `useAgentsStore().options[sessionId]`. */
export function requestAgentOptions(sessionId: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "agent.options", sessionId }));
}

/** Ephemeral; the answer lands in `useDropsStore().drops`. Also sent by the driver on every welcome. */
export function requestDrops(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "drop.list" }));
}

/**
 * `http://<host>:<port>` of the live connection, the prefix for `Drop.file.path` blob fetches.
 * `null` when not connected: there is no host to fetch from and no drop list to fetch for.
 */
export function hostBaseUrl(): string | null {
  if (useConnectionStore.getState().status !== "connected" || hostAuthority === null) return null;
  return `http://${hostAuthority}`;
}

/** Ephemeral; the host keeps the token per device, so this is re-sent on every connection. */
export function registerPush(token: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "push.register", token }));
}

export function unregisterPush(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "push.unregister" }));
}

/**
 * Ephemeral; the answer lands in `useAgentsStore().images[sessionId][id]`. Asked at most once per
 * ref: a store entry (even `null`, "host has none") or an in-flight request means no new frame.
 */
export function requestAgentImage(sessionId: string, id: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  if (useAgentsStore.getState().images[sessionId]?.[id] !== undefined) return;
  const key = imageKey(sessionId, id);
  if (imagesInFlight.has(key)) return;
  imagesInFlight.add(key);
  socket.send(encode({ t: "agent.image", sessionId, id }));
}

/** Reliable; resolves on ack, rejects with an `AckError`-shaped `Error` on nack. */
export function sendCommand(cmd: Command): Promise<void> {
  const promise = commandQueue.enqueue(cmd);
  commandQueue.flush((message) => socket.send(encode(message)));
  return promise;
}

/** Monotonic ms, matching `InputEvent.t`'s unit. */
export function getClientTime(): number {
  return performance.now();
}

export const connection = {
  start(): void {
    if (started) return;
    started = true;
    setActions({
      insertText: (text) => sendCommand({ kind: "text.insert", text }),
      startPairing: () => {
        void dispatch({ type: "startPairing" });
      },
      submitPin: (pin) => {
        void dispatch({ type: "pinEntered", pin });
      },
      switchHost: (id) => {
        void switchHost(id);
      },
      forgetHost: (id) => {
        void forgetHost(id);
      },
    });
    boot().catch((error: unknown) => {
      warn("boot", "failed", error);
    });
  },
  stop(): void {
    if (!started) return;
    started = false;
    appStateSubscription?.remove();
    appStateSubscription = null;
    discovery.stop();
    socket.close();
    clearTimeout(retryTimer);
    retryTimer = undefined;
    machine = null;
  },
};

/** Keeps Bonjour browsing (and `useConnectionStore().discovered` fresh) while a host picker is open. */
export function browseHosts(on: boolean): void {
  discovery.browse(on);
}

/** Mounts the connection lifecycle to the app's root component tree. */
export function useConnectionLifecycle(): void {
  useEffect(() => {
    connection.start();
    return () => {
      connection.stop();
    };
  }, []);
}
