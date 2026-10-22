/**
 * Audio for Relay calls (ios/VoiceCallModule.swift): an echo-cancelled microphone streamed out as
 * 100 ms frames of 16 kHz PCM16 (`audio` events, base64) and the host's 24 kHz PCM16 played in
 * order (`play`), with `flush` to drop what is queued when Isaac talks over the assistant. Null
 * on a dev client built before the module existed; the app then says calls need a new build.
 */
import { requireOptionalNativeModule, type NativeModule } from "expo-modules-core";

export type VoiceCallEvents = {
  /** 100 ms of microphone, PCM16 LE mono 16 kHz, base64. Not sent while muted. */
  audio: (event: { pcm: string }) => void;
  /** Microphone loudness, 0..1, about every 60 ms (0 while muted). */
  level: (event: { value: number }) => void;
  /** iOS took the audio session (a phone call, Siri); the call should end. */
  interrupted: () => void;
};

declare class VoiceCallNative extends NativeModule<VoiceCallEvents> {
  requestPermission(): Promise<boolean>;
  /** Opens the microphone and the player; audio events start flowing. */
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  /** Queues PCM16 LE mono 24 kHz (base64) after what is already playing. */
  play(pcm: string): void;
  /** Drops everything queued and stops playback now. */
  flush(): void;
}

export const VoiceCall = requireOptionalNativeModule<VoiceCallNative>("VoiceCall");
