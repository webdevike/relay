/**
 * Starts and ends the phone's side of a call: microphone permission, the native audio engine
 * (`modules/voice-call`), its frames out as `call.audio`, mute and hang-up. The host's answers come
 * back through `src/call/frames.ts`. Whatever ends the call (hang-up, the host, the socket, iOS
 * taking the audio session) stops the engine once.
 */
import { randomUUID } from "expo-crypto";
import type { EventSubscription } from "expo-modules-core";
import { sendCall } from "@/connection";
import { useCallStore } from "@/state/call";
import { useConnectionStore } from "@/state/connection";
import { VoiceCall } from "../../modules/voice-call";
import { callStats } from "./stats";

let subscriptions: EventSubscription[] = [];
/** A call whose microphone has produced nothing this long after opening is ended with a reason. */
const NO_AUDIO_MS = 3_000;
let unsubscribeStore: (() => void) | null = null;
/** Microphone and level events that reached JS in the current call, for its report. */
let micEvents = 0;
let levelEvents = 0;

/** Whether this build has the call audio module (dev clients from before calls do not). */
export function callsSupported(): boolean {
  return VoiceCall !== null;
}

/**
 * Calls `agent`. Resolves once the microphone is open and `call.start` is sent; the screen then
 * follows `useCallStore().call`. Throws with a message for the person when it cannot start.
 */
export async function startCall(agent: string): Promise<void> {
  const native = VoiceCall;
  if (native === null) throw new Error("Calls need a newer build of Relay on this phone.");
  if (useConnectionStore.getState().status !== "connected") throw new Error("Connect to your Mac to call.");
  hangUp();
  if (!(await native.requestPermission())) throw new Error("Allow microphone access for Relay in Settings to call.");
  const id = randomUUID();
  useCallStore.getState().begin(id, agent);
  micEvents = 0;
  levelEvents = 0;
  callStats.audioIn = 0;
  subscriptions = [
    native.addListener("audio", ({ pcm }) => {
      micEvents += 1;
      sendCall({ t: "call.audio", callId: id, pcm });
    }),
    native.addListener("level", ({ value }) => {
      levelEvents += 1;
      useCallStore.getState().update(id, { level: value });
    }),
    native.addListener("interrupted", () => {
      endCall("The call was interrupted");
    }),
  ];
  unsubscribeStore = useCallStore.subscribe((store) => {
    if (store.call?.id !== id || store.call.state === "ended") teardown();
  });
  try {
    await native.start();
  } catch (error) {
    endCall(error instanceof Error && error.message !== "" ? error.message : "Couldn't open the microphone.");
    return;
  }
  // Ended while the microphone was opening (hung up, socket gone): the store watcher already tore down.
  const call = useCallStore.getState().call;
  if (call?.id !== id || call.state === "ended") {
    native.stop();
    return;
  }
  sendCall({ t: "call.start", callId: id, agent });
  // A deaf call looks exactly like one where nobody answers; say so instead.
  setTimeout(() => {
    if (micEvents > 0 || useCallStore.getState().call?.id !== id) return;
    endCall("The microphone sent no audio");
  }, NO_AUDIO_MS);
}

/** The native engine's state and what reached JS, read before hanging up stops the engine. */
function report(): string {
  return `${VoiceCall?.diagnostics() ?? "no native module"}; js mic events ${String(micEvents)}, level events ${String(levelEvents)}, reply frames ${String(callStats.audioIn)}`;
}

/**
 * Hangs up (`error` when it ends because something failed); the call screen shows it ended. The
 * host always gets the audio report in `reason`, so its log shows what both directions did.
 */
export function endCall(error?: string): void {
  const call = useCallStore.getState().call;
  if (call === null || call.state === "ended") return;
  const details = report();
  sendCall({ t: "call.end", callId: call.id, reason: `${error ?? "hung up"} (${details})`.slice(0, 2000) });
  useCallStore.getState().update(call.id, { state: "ended", error: error === undefined ? null : `${error} (${details})` });
}

export function setCallMuted(muted: boolean): void {
  const call = useCallStore.getState().call;
  if (call === null || call.state === "ended") return;
  VoiceCall?.setMuted(muted);
  sendCall({ t: "call.mute", callId: call.id, muted });
  useCallStore.getState().update(call.id, { muted, level: 0 });
}

/** Ends any call and forgets it, for leaving the call screen. */
export function hangUp(): void {
  endCall();
  teardown();
  useCallStore.getState().clear();
}

function teardown(): void {
  for (const subscription of subscriptions) subscription.remove();
  subscriptions = [];
  unsubscribeStore?.();
  unsubscribeStore = null;
  VoiceCall?.stop();
}
