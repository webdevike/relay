/**
 * Apple's recognizer (expo-speech-recognition) switches the audio session to playAndRecord and
 * activates it on every start, and never hands it back: after it ends, however it ends (stop,
 * abort, an error, the screen going away), the session stays active for recording. Every end of
 * it, from the composer's dictation or the hold-to-talk button, hands the session back as
 * playback only, deactivated, so iOS has no recording session of Relay's left. A live call owns
 * the session and is left alone.
 */
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { warn } from "@/connection/log";
import { callIsLive } from "@/state/call";

export function releaseSpeechSession(): void {
  if (callIsLive()) return;
  try {
    ExpoSpeechRecognitionModule.setCategoryIOS({ category: "playback", categoryOptions: [], mode: "default" });
    ExpoSpeechRecognitionModule.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
  } catch (error) {
    warn("dictation", "couldn't hand back the audio session", error);
  }
}

ExpoSpeechRecognitionModule.addListener("end", releaseSpeechSession);
