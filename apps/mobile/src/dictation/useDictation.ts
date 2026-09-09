import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { PermissionStatus } from "expo-modules-core";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionOptions,
} from "expo-speech-recognition";
import type { Command } from "@relay/protocol";
import { sendCommand } from "@/connection";
import { useConnectionStore } from "@/state/connection";
import { useDictationStore } from "./signals";
import { debug } from "@/connection/log";
import { DictationMachine, realScheduler, type DictationSnapshot } from "./machine";

export interface UseDictationResult {
  state: DictationSnapshot;
  transcript: string;
  start: () => void;
  /** `submit` presses Return on the Mac after the text lands. */
  stop: (options?: { submit?: boolean }) => void;
  cancel: () => void;
  error: string | null;
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

/** Extract the AckError-shaped `code` off a `sendCommand` rejection, falling back to "internal". */
function ackErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return "internal";
}

export function useDictation(): UseDictationResult {
  const connected = useConnectionStore((state) => state.status === "connected");
  const machineRef = useRef<DictationMachine | null>(null);
  const snapshotRef = useRef<((snapshot: DictationSnapshot) => void) | null>(null);
  machineRef.current ??= new DictationMachine({
    scheduler: realScheduler,
    onChange: (snapshot) => {
      debug("dictation", snapshot.phase, snapshot.submit ? "submit" : "", snapshot.errorCode ?? "");
      snapshotRef.current?.(snapshot);
      useDictationStore.getState().setPhase(snapshot.phase);
      useDictationStore.getState().setSubmitted(snapshot.submit);
    },
    onEffect: (effect) => {
      const cmd: Command = { kind: "text.insert", text: effect.text };
      const deliver = effect.submit
        ? sendCommand(cmd).then(() => sendCommand({ kind: "key.press", key: "return" }))
        : sendCommand(cmd);
      deliver.then(
        () => machineRef.current?.send({ type: "sendOk" }),
        (err: unknown) => {
          machineRef.current?.send({ type: "sendFailed", code: ackErrorCode(err) });
        },
      );
    },
  });
  const machine = machineRef.current;
  const [snapshot, setSnapshot] = useState<DictationSnapshot>(() => machine.getSnapshot());
  snapshotRef.current = setSnapshot;

  const dispatch = (event: Parameters<DictationMachine["send"]>[0]): void => {
    machine.send(event);
  };

  useSpeechRecognitionEvent("result", (event) => {
    const text = event.results[0]?.transcript ?? "";
    if (text.length === 0) return;
    dispatch(event.isFinal ? { type: "final", text } : { type: "partial", text });
  });

  useSpeechRecognitionEvent("error", (event) => {
    dispatch({ type: "recognizerError", code: event.error });
  });

  useSpeechRecognitionEvent("end", () => {
    if (machine.getSnapshot().phase === "listening") {
      dispatch({ type: "recognizerError", code: "aborted" });
    }
  });

  useEffect(
    () => () => {
      if (machine.getSnapshot().phase === "listening" || machine.getSnapshot().phase === "finishing") {
        ExpoSpeechRecognitionModule.abort();
      }
    },
    [machine],
  );

  const start = (): void => {
    if (!connected || snapshot.phase !== "idle") return;
    dispatch({ type: "pressStart" });
    void beginListening(machine, dispatch);
  };

  const stop = (options?: { submit?: boolean }): void => {
    if (machine.getSnapshot().phase !== "listening") return;
    ExpoSpeechRecognitionModule.stop();
    dispatch({ type: "pressStop", submit: options?.submit === true });
  };

  const cancel = (): void => {
    const phase = machine.getSnapshot().phase;
    if (phase === "listening" || phase === "finishing") ExpoSpeechRecognitionModule.abort();
    dispatch({ type: "reset" });
  };

  return { state: snapshot, transcript: snapshot.transcript, start, stop, cancel, error: snapshot.errorCode };
}

async function beginListening(
  machine: DictationMachine,
  dispatch: (event: Parameters<DictationMachine["send"]>[0]) => void,
): Promise<void> {
  if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
    dispatch({ type: "recognizerError", code: "service-not-allowed" });
    return;
  }

  const existing = await ExpoSpeechRecognitionModule.getPermissionsAsync();
  const granted =
    existing.status === PermissionStatus.GRANTED
      ? true
      : existing.status === PermissionStatus.UNDETERMINED
        ? (await ExpoSpeechRecognitionModule.requestPermissionsAsync()).status === PermissionStatus.GRANTED
        : false;

  dispatch({ type: "permission", granted });
  if (!granted) return;
  if (machine.getSnapshot().phase !== "listening") return;
  ExpoSpeechRecognitionModule.start(RECOGNIZER_OPTIONS);
}

export function openDictationSettings(): void {
  void Linking.openSettings();
}
