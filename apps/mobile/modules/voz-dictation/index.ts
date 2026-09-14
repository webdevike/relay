/**
 * Voz (Desert Ant Labs): on-device speech recognition for hold-to-talk. Unlike Apple's
 * recognizer it has no partial results; `stop()` resolves with the whole transcript. The native
 * side lives in ios/VozDictationModule.swift; the model is a 467 MB one-time download.
 */
import { requireNativeModule, type NativeModule } from "expo-modules-core";

export type VozDictationEvents = {
  /** Microphone loudness while recording, 0..1, about every 60 ms. */
  level: (event: { value: number }) => void;
  downloadProgress: (event: { fraction: number }) => void;
};

declare class VozDictationNative extends NativeModule<VozDictationEvents> {
  isDownloaded(): boolean;
  download(): Promise<void>;
  prepare(): Promise<void>;
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<string>;
  abort(): void;
}

export const VozDictation = requireNativeModule<VozDictationNative>("VozDictation");
