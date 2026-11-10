/**
 * Pasting an image into a text input. `modules/paste-image` makes React Native's text inputs offer Paste
 * for a copied image (long-press the field, Paste, or the keyboard's paste) and hands the image over as a
 * JPEG instead of dropping it. An input says it is focused through `usePasteImage(active, onImage)`; with
 * none active, Paste behaves as iOS always did. A binary without the native module (builds up to 17)
 * simply cannot paste images: there is no separate paste button (Isaac, 2026-11-10).
 */
import { useEffect, useRef } from "react";
import { requireOptionalNativeModule, type NativeModule } from "expo-modules-core";
import type { PendingImage } from "@/dictation/machine";

type PasteImageEvents = {
  pasteImage: (event: { data: string; width: number; height: number }) => void;
};

declare class PasteImageNative extends NativeModule<PasteImageEvents> {
  setActive(active: boolean): void;
}

/** Null in builds up to 17, which lack the module: there image paste does nothing. */
const native = requireOptionalNativeModule<PasteImageNative>("PasteImage");

/** While `active` (the field is focused), a pasted clipboard image reaches `onImage` as a JPEG. */
export function usePasteImage(active: boolean, onImage: (image: PendingImage) => void): void {
  const latest = useRef(onImage);
  latest.current = onImage;
  useEffect(() => {
    if (native === null || !active) return;
    native.setActive(true);
    const subscription = native.addListener("pasteImage", ({ data, width, height }) => {
      latest.current({ mimeType: "image/jpeg", data, width, height });
    });
    return () => {
      subscription.remove();
      native.setActive(false);
    };
  }, [active]);
}
