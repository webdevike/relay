/**
 * The one running dictation actor. Provides the machine's three effects with a real recognizer
 * (Voz on device when chosen and downloaded, else expo-speech-recognition) and the connection's
 * `sendCommand`.
 */
import { PermissionStatus } from "expo-modules-core";
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionOptions,
} from "expo-speech-recognition";
import { createActor, fromCallback, fromPromise } from "xstate";
import { sendCommand } from "@/connection";
import { debug, warn } from "@/connection/log";
import { useSettingsStore } from "@/state/settings";
import { VozDictation } from "../../modules/voz-dictation";
import { deliverDictation } from "./deliver";
import {
  dictationMachine,
  orbOf,
  phaseOf,
  type DeliverInput,
  type PermissionOutcome,
  type RecognizerCommand,
  type RecognizerEvent,
} from "./machine";

/** Voz is the recognizer only once its model is on the phone; until then Apple's takes every press. */
export function usingVoz(): boolean {
  return useSettingsStore.getState().recognizer === "voz" && VozDictation.isDownloaded();
}

/**
 * Loads the model ahead of the first press: a cold load can take seconds (20 s once after a
 * download while the Neural Engine specializes it) and the machine gives `finishing` 1.5 s.
 */
export function warmVoz(): void {
  if (!usingVoz()) return;
  VozDictation.prepare().catch((error: unknown) => {
    warn("dictation", "voz warm-up failed", error);
  });
}

const RECOGNIZER_OPTIONS: ExpoSpeechRecognitionOptions = {
  lang: "en-US",
  interimResults: true,
  continuous: true,
  addsPunctuation: true,
  iosTaskHint: "dictation",
  volumeChangeEventOptions: { enabled: true, intervalMillis: 60 },
  iosCategory: {
    category: "playAndRecord",
    categoryOptions: ["duckOthers", "defaultToSpeaker"],
    mode: "measurement",
  },
};

const checkPermission = fromPromise<PermissionOutcome>(async () => {
  if (usingVoz()) return (await VozDictation.requestPermission()) ? "granted" : "denied";
  if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) return "unavailable";
  const existing = await ExpoSpeechRecognitionModule.getPermissionsAsync();
  if (existing.status === PermissionStatus.GRANTED) return "granted";
  if (existing.status !== PermissionStatus.UNDETERMINED) return "denied";
  const requested = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  return requested.status === PermissionStatus.GRANTED ? "granted" : "denied";
});

/** Runs the recognizer for the whole `active` state; aborts it if the machine leaves early. */
const recognizer = fromCallback<RecognizerCommand>(({ sendBack, receive }) =>
  usingVoz() ? runVoz(sendBack, receive) : runApple(sendBack, receive),
);

type SendBack = (event: RecognizerEvent) => void;
type Receive = (listener: (command: RecognizerCommand) => void) => void;

function runApple(report: SendBack, receive: Receive): () => void {
  let ended = false;
  const subscriptions = [
    ExpoSpeechRecognitionModule.addListener("result", (event) => {
      const text = event.results[0]?.transcript ?? "";
      if (text.length === 0) return;
      report(event.isFinal ? { type: "final", text } : { type: "partial", text });
    }),
    ExpoSpeechRecognitionModule.addListener("error", (event) => {
      ended = true;
      report({ type: "recognizerError", code: event.error });
    }),
    ExpoSpeechRecognitionModule.addListener("end", () => {
      ended = true;
      report({ type: "recognizerEnd" });
    }),
  ];
  receive(() => {
    ExpoSpeechRecognitionModule.stop();
  });
  ExpoSpeechRecognitionModule.start(RECOGNIZER_OPTIONS);
  return () => {
    for (const subscription of subscriptions) subscription.remove();
    if (!ended) ExpoSpeechRecognitionModule.abort();
  };
}

/**
 * Voz records while the finger is down and transcribes on `stop`, so the machine hears nothing
 * until then: one `final` (or `recognizerEnd` for silence) lands while it is `finishing`.
 */
function runVoz(report: SendBack, receive: Receive): () => void {
  let ended = false;
  receive(() => {
    ended = true;
    VozDictation.stop().then(
      (text) => {
        report(text.trim().length === 0 ? { type: "recognizerEnd" } : { type: "final", text });
      },
      (error: unknown) => {
        warn("dictation", "voz failed", error);
        report({ type: "recognizerError", code: "voz" });
      },
    );
  });
  VozDictation.start().catch((error: unknown) => {
    warn("dictation", "voz start failed", error);
    ended = true;
    report({ type: "recognizerError", code: "voz" });
  });
  return () => {
    if (!ended) VozDictation.abort();
  };
}

const deliver = fromPromise<null, DeliverInput>(async ({ input }) => {
  await deliverDictation(input, sendCommand);
  return null;
});

export const dictationActor = createActor(
  dictationMachine.provide({ actors: { checkPermission, recognizer, deliver } }),
);

dictationActor.subscribe((snapshot) => {
  debug(
    "dictation",
    phaseOf(snapshot),
    `orb=${orbOf(snapshot)}`,
    snapshot.context.submit ? "submit" : "",
    snapshot.context.errorCode ?? "",
  );
});

dictationActor.start();

warmVoz();
