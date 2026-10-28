/**
 * Calls from the app: a live (GPT-Live) call first, the legacy call (`./controller`) when GPT-Live
 * is unavailable or this build has no LiveCall module. `followLiveCalls` mirrors the native
 * engine into `useLiveCallStore` (calls the Action Button started too) and, once the app is in
 * the foreground, runs the legacy call a pending fallback asks for: an intent whose live call
 * could not go live opens Relay on that assistant's thread and calls it the old way.
 */
import { AppState } from "react-native";
import { router } from "expo-router";
import { callIsLive } from "@/state/call";
import { useConnectionStore } from "@/state/connection";
import { useLiveCallStore } from "@/state/liveCall";
import { LiveCall } from "../../modules/live-call";
import { hangUp, startCall } from "./controller";

/** How long a fallback waits for the app's connection after Relay opens. */
const CONNECT_WAIT_MS = 15_000;

let following = false;
/** Agents whose live call `startVoiceCall` is starting: their fallback is its own to run. */
const starting = new Set<string>();

/** Starts following the native engine; once, from the root layout. */
export function followLiveCalls(): void {
  const native = LiveCall;
  if (native === null || following) return;
  following = true;
  useLiveCallStore.getState().apply(native.current());
  native.addListener("state", (snapshot) => {
    // One call at a time: an Action Button call replaces a legacy one.
    if (snapshot.state === "connecting" && callIsLive()) hangUp();
    useLiveCallStore.getState().apply(snapshot);
  });
  native.addListener("fallback", ({ agent }) => {
    if (!starting.has(agent)) runPendingFallback();
  });
  AppState.addEventListener("change", (next) => {
    if (next !== "active") return;
    useLiveCallStore.getState().apply(native.current());
    runPendingFallback();
  });
  runPendingFallback();
}

/**
 * The thread's Call button: a live call, or the legacy call when GPT-Live is unavailable.
 * Throws with a message for the person when neither can start.
 */
export async function startVoiceCall(agent: string): Promise<void> {
  useLiveCallStore.getState().setFailure(null);
  const native = LiveCall;
  if (native === null) {
    await startCall(agent);
    return;
  }
  starting.add(agent);
  let result;
  try {
    result = await native.start(agent);
  } finally {
    starting.delete(agent);
  }
  if (result.outcome === "failed") throw new Error(result.message);
  if (result.outcome !== "fallback") return;
  native.consumePendingFallback();
  await startCall(agent);
}

export function endLiveCall(): void {
  void LiveCall?.end();
}

export function setLiveCallMuted(muted: boolean): void {
  LiveCall?.setMuted(muted);
}

function runPendingFallback(): void {
  if (LiveCall === null || AppState.currentState !== "active") return;
  const pending = LiveCall.consumePendingFallback();
  if (pending === null) return;
  router.navigate({ pathname: "/eva", params: { agent: pending.agent } });
  whenConnected(CONNECT_WAIT_MS)
    .then(() => startCall(pending.agent))
    .catch((error: unknown) => {
      const message = error instanceof Error && error.message !== "" ? error.message : "Couldn't start the call.";
      useLiveCallStore.getState().setFailure({ agent: pending.agent, message });
    });
}

function whenConnected(ms: number): Promise<void> {
  if (useConnectionStore.getState().status === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Connect to your Mac to call."));
    }, ms);
    const unsubscribe = useConnectionStore.subscribe((store) => {
      if (store.status !== "connected") return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}
