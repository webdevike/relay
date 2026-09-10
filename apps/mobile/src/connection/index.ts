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
import { setActions } from "@/state/actions";
import { useSettingsStore } from "@/state/settings";
import * as identity from "./identity";
import { Discovery, type DiscoveredService } from "./discovery";
import { parseManualHost } from "./manual-host";
import { RelaySocket } from "./socket";
import { SessionMachine, type Effect } from "./session";
import { CommandQueue } from "./commands";
import { debug, warn } from "./log";

let started = false;
let deviceId = "";
let pairedBonjourName: string | null = null;
let currentCandidate: DiscoveredService | null = null;
let machine: SessionMachine | null = null;
let wasActive = true;
let appStateSubscription: NativeEventSubscription | null = null;
let retryTimer: number | undefined;

const commandQueue = new CommandQueue();
const socket = new RelaySocket();
const discovery = new Discovery({
  onCandidate: (service) => {
    currentCandidate = service;
    void dispatch({ type: "serviceFound", service });
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
  if (message.t === "welcome") commandQueue.onReconnect((m) => socket.send(encode(m)));
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
        socket.open(`ws://${effect.host}:${effect.port}${WS_PATH}`);
        break;
      case "send":
        socket.send(encode(effect.message));
        break;
      case "startDiscovery": {
        // A manual host replaces Bonjour entirely: hand the machine a synthetic resolved service.
        const manual = parseManualHost(useSettingsStore.getState().manualHost);
        if (manual === null) {
          discovery.start(pairedBonjourName);
        } else {
          discovery.stop();
          currentCandidate = manual;
          void dispatch({ type: "serviceFound", service: manual });
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
      case "storeSecret":
        await identity.savePairedMac({
          macName: currentCandidate?.name ?? "Mac",
          secretHex: effect.hex,
          bonjourName: currentCandidate?.name ?? "",
        });
        pairedBonjourName = currentCandidate?.name ?? null;
        break;
      case "forgetSecret":
        await identity.forgetPairedMac();
        pairedBonjourName = null;
        break;
      case "storeUpdate":
        useConnectionStore.getState().set(effect.partial);
        break;
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

let settingsSubscription: (() => void) | null = null;

async function boot(): Promise<void> {
  deviceId = await identity.getDeviceId();
  const paired = await identity.getPairedMac();
  pairedBonjourName = paired?.bonjourName ?? null;
  wasActive = AppState.currentState === "active";
  appStateSubscription = AppState.addEventListener("change", onAppStateChange);
  settingsSubscription = useSettingsStore.subscribe((next, prev) => {
    if (next.manualHost === prev.manualHost) return;
    // Address changed under a live session: drop it and connect to the new target (or resume
    // discovery). The paired secret is kept; a host that does not know us answers
    // `unknown_device` and the normal re-pair path takes over.
    void identity.getPairedMac().then((current) => resetSession(current?.secretHex ?? null));
  });
  await resetSession(paired?.secretHex ?? null);
}

/** Tears down socket, timers and discovery, then starts a fresh machine with `pairedSecretHex`. */
async function resetSession(pairedSecretHex: string | null): Promise<void> {
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
    pairedSecretHex,
  });
  await dispatch({ type: "appActive" });
}

async function runForgetMac(): Promise<void> {
  await identity.forgetPairedMac();
  pairedBonjourName = null;
  await resetSession(null);
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
      forgetMac: () => {
        void runForgetMac();
      },
      sendReply: (sessionId, text) => sendCommand({ kind: "agent.reply", sessionId, text }),
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
    settingsSubscription?.();
    settingsSubscription = null;
    discovery.stop();
    socket.close();
    clearTimeout(retryTimer);
    retryTimer = undefined;
    machine = null;
  },
  forget(): void {
    void runForgetMac();
  },
};

/** Mounts the connection lifecycle to the app's root component tree. */
export function useConnectionLifecycle(): void {
  useEffect(() => {
    connection.start();
    return () => {
      connection.stop();
    };
  }, []);
}
