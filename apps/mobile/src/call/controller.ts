/**
 * Runs the legacy call machine (`legacyCall.machine.ts`) on the phone's native wiring: microphone
 * permission, the native audio engine (`modules/voice-call`), its frames out as `call.audio`, mute
 * and hang-up. The machine decides; this file only performs its effects and projects its state
 * into `useCallStore`, which the screens read. The host's answers come back through
 * `src/call/frames.ts` (`callHostState`), the socket's end through `connection/index.ts`
 * (`callSocketEpochEnded`). Whatever ends the call stops the engine, which lets go of the
 * microphone. A call that ends cleanly is forgotten at once, so its screen closes straight onto the
 * thread; one that ends on an error stays, with the error, until its screen is closed.
 */
import { randomUUID } from "expo-crypto";
import { createActor, fromCallback, fromPromise, waitFor } from "xstate";
import type { CallState } from "@relay/protocol";
import { sendCall, socketEpoch } from "@/connection";
import { useCallStore } from "@/state/call";
import { useConnectionStore } from "@/state/connection";
import { VoiceCall } from "../../modules/voice-call";
import { callView, legacyCallMachine, type LegacyCallEvent } from "./legacyCall.machine";
import { callStats } from "./stats";

/** Microphone and level events that reached JS in the current call, for its report. */
let micEvents = 0;
let levelEvents = 0;

/** The native engine's state and what reached JS, read before hanging up stops the engine. */
function report(): string {
  return `${VoiceCall?.diagnostics() ?? "no native module"}; js mic events ${String(micEvents)}, level events ${String(levelEvents)}, reply frames ${String(callStats.audioIn)}`;
}

const legacyCall = createActor(
  legacyCallMachine.provide({
    actors: {
      openMic: fromPromise(async () => {
        if (VoiceCall === null) throw new Error("Calls need a newer build of Relay on this phone.");
        await VoiceCall.start();
        return null;
      }),
      engineEvents: fromCallback<LegacyCallEvent, { callId: string }>(({ input, sendBack }) => {
        const native = VoiceCall;
        if (native === null) return undefined;
        const { callId } = input;
        micEvents = 0;
        levelEvents = 0;
        callStats.audioIn = 0;
        const subscriptions = [
          native.addListener("audio", ({ pcm }) => {
            micEvents += 1;
            if (micEvents === 1) sendBack({ type: "mic.heard" });
            sendCall({ t: "call.audio", callId, pcm });
          }),
          native.addListener("level", ({ value }) => {
            levelEvents += 1;
            useCallStore.getState().update(callId, { level: value });
          }),
          native.addListener("interrupted", () => {
            sendBack({ type: "call.interrupted" });
          }),
        ];
        return () => {
          for (const subscription of subscriptions) subscription.remove();
        };
      }),
    },
    actions: {
      sendStart: ({ context }) => {
        if (context.callId !== null && context.agent !== null)
          sendCall({ t: "call.start", callId: context.callId, agent: context.agent });
      },
      sendEnd: ({ context }) => {
        if (context.callId !== null) sendCall({ t: "call.end", callId: context.callId, reason: context.endNote });
      },
      release: () => {
        VoiceCall?.stop();
      },
    },
  }),
  { input: { diagnostics: report } },
);

// The store is the machine's projection: the screens read it, only this writes the call's state.
legacyCall.subscribe((snapshot) => {
  const view = callView(snapshot);
  const store = useCallStore.getState();
  if (view === null) {
    if (store.call !== null) store.clear();
    return;
  }
  if (store.call?.id !== view.id) store.begin(view.id, view.agent);
  const current = useCallStore.getState().call;
  if (current?.state !== view.state || current.text !== view.text || current.error !== view.error)
    store.update(view.id, { state: view.state, text: view.text, error: view.error });
});
legacyCall.start();

/** Whether this build has the call audio module (dev clients from before calls do not). */
export function callsSupported(): boolean {
  return VoiceCall !== null;
}

/**
 * Calls `agent`. Resolves once the microphone is open and `call.start` is sent; the screen then
 * follows `useCallStore().call`. Throws with a message for the person when it cannot start. A call
 * already opening its microphone (a double tap) wins; this one is dropped.
 */
export async function startCall(agent: string): Promise<void> {
  const native = VoiceCall;
  if (native === null) throw new Error("Calls need a newer build of Relay on this phone.");
  if (useConnectionStore.getState().status !== "connected") throw new Error("Connect to your Mac to call.");
  if (!(await native.requestPermission())) throw new Error("Allow microphone access for Relay in Settings to call.");
  const callId = randomUUID();
  legacyCall.send({ type: "call.start", callId, agent, epoch: socketEpoch() });
  if (legacyCall.getSnapshot().context.callId !== callId) return;
  await waitFor(legacyCall, (snapshot) => snapshot.context.callId !== callId || !snapshot.matches({ active: "opening_mic" }));
}

export function setCallMuted(muted: boolean): void {
  const call = useCallStore.getState().call;
  if (call === null || call.state === "ended") return;
  VoiceCall?.setMuted(muted);
  sendCall({ t: "call.mute", callId: call.id, muted });
  useCallStore.getState().update(call.id, { muted, level: 0 });
}

/** Ends any call and forgets it: the hang-up button, closing the call screen. */
export function hangUp(): void {
  legacyCall.send({ type: "call.hangUp" });
}

/** Call `id`'s screen went away (its thread unmounted): a call nobody can see or hang up is ended. */
export function leaveCall(id: string): void {
  if (legacyCall.getSnapshot().context.callId === id) hangUp();
}

/** A host `call.state` for call `callId` (routed by `call/frames.ts`). */
export function callHostState(callId: string, state: CallState, text: string | null, error: string | null): void {
  legacyCall.send({ type: "host.state", callId, state, text, error });
}

/** Socket epoch `epoch` ended: a call on it ends with it (connection/index.ts). */
export function callSocketEpochEnded(epoch: number): void {
  legacyCall.send({ type: "socket.epochEnded", epoch });
}
