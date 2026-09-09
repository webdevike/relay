/**
 * The one running dictation actor. Provides the machine's three effects with the real
 * expo-speech-recognition module and the connection's `sendCommand`.
 */
import { PermissionStatus } from "expo-modules-core";
import { ExpoSpeechRecognitionModule, type ExpoSpeechRecognitionOptions } from "expo-speech-recognition";
import { createActor, fromCallback, fromPromise } from "xstate";
import type { Command } from "@relay/protocol";
import { sendCommand } from "@/connection";
import { debug } from "@/connection/log";
import { dictationMachine, orbOf, phaseOf, type DeliverInput, type PermissionOutcome, type RecognizerCommand, type RecognizerEvent } from "./machine";

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
  if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) return "unavailable";
  const existing = await ExpoSpeechRecognitionModule.getPermissionsAsync();
  if (existing.status === PermissionStatus.GRANTED) return "granted";
  if (existing.status !== PermissionStatus.UNDETERMINED) return "denied";
  const requested = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  return requested.status === PermissionStatus.GRANTED ? "granted" : "denied";
});

/** Runs the recognizer for the whole `active` state; aborts it if the machine leaves early. */
const recognizer = fromCallback<RecognizerCommand>(({ sendBack, receive }) => {
  const report = (event: RecognizerEvent): void => {
    sendBack(event);
  };
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
});

const deliver = fromPromise<null, DeliverInput>(async ({ input }) => {
  const cmd: Command = { kind: "text.insert", text: input.text };
  await sendCommand(cmd);
  if (input.submit) await sendCommand({ kind: "key.press", key: "return" });
  return null;
});

export const dictationActor = createActor(dictationMachine.provide({ actors: { checkPermission, recognizer, deliver } }));

dictationActor.subscribe((snapshot) => {
  debug("dictation", phaseOf(snapshot), `orb=${orbOf(snapshot)}`, snapshot.context.submit ? "submit" : "", snapshot.context.errorCode ?? "");
});

dictationActor.start();
