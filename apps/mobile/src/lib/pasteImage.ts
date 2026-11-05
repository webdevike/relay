/**
 * Pasting an image into a text input. `modules/paste-image` makes React Native's text inputs offer Paste
 * for a copied image (long-press the field, Paste) and hands the image over as a JPEG instead of dropping it.
 * An input says it is focused through `usePasteImage(active, onImage)`; with none active, Paste behaves as
 * iOS always did. A build without the native module (an older install running this bundle) simply has no
 * image paste: the composer's + button still attaches photos.
 */
import { useEffect, useRef } from "react";
import { requireOptionalNativeModule, type NativeModule } from "expo-modules-core";
import type { PendingImage } from "@/dictation/machine";

interface PasteImageEvents {
  pasteImage: (event: { data: string; width: number; height: number }) => void;
}

declare class PasteImageNative extends NativeModule<PasteImageEvents> {
  setActive(active: boolean): void;
}

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
