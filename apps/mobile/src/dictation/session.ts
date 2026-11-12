/**
 * Apple's recognizer (expo-speech-recognition) switches the audio session to playAndRecord and
 * activates it on every start, and never hands it back: after it ends, however it ends (stop,
 * abort, an error, the screen going away), the session stays active for recording. Every end of
 * it, from the composer's dictation or the hold-to-talk button, hands the session back as
 * playback only, deactivated, so iOS has no recording session of Relay's left. Only while
 * dictation owns the session (`audioOwner.machine.ts`): a call, live or legacy, that came up meanwhile
 * runs on it and is left alone.
 */
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { createActor } from "xstate";
import { warn } from "@/connection/log";
import { callIsLive, useCallStore } from "@/state/call";
import { liveCallIsUp, useLiveCallStore } from "@/state/liveCall";
import { audioOwnerMachine } from "./audioOwner.machine";

export const audioOwner = createActor(
  audioOwnerMachine.provide({
    actions: {
      handBack: () => {
        try {
          ExpoSpeechRecognitionModule.setCategoryIOS({ category: "playback", categoryOptions: [], mode: "default" });
          ExpoSpeechRecognitionModule.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
        } catch (error) {
          warn("dictation", "couldn't hand back the audio session", error);
        }
      },
    },
  }),
).start();

/** Apple's recognizer ended: hands the session back only if dictation still owns it. */
export function releaseSpeechSession(): void {
  audioOwner.send({ type: "dictation.ended" });
}

ExpoSpeechRecognitionModule.addListener("end", releaseSpeechSession);

// The calls' claims follow their stores: the native live call's mirror and the legacy call.
function syncCalls(): void {
  audioOwner.send({ type: "calls.changed", liveCall: liveCallIsUp(), legacyCall: callIsLive() });
}
useLiveCallStore.subscribe(syncCalls);
useCallStore.subscribe(syncCalls);
syncCalls();
