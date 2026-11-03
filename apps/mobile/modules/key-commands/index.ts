/**
 * Hardware-keyboard shortcuts (Cmd+[ goes back), also during iPhone Mirroring. The native side is
 * ios/KeyCommandsModule.swift; it emits `back` for each press.
 */
import { requireNativeModule, type NativeModule } from "expo-modules-core";

type KeyCommandsEvents = {
  back: () => void;
};

declare class KeyCommandsNative extends NativeModule<KeyCommandsEvents> {}

export const KeyCommands = requireNativeModule<KeyCommandsNative>("KeyCommands");
