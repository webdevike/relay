import { TurboModuleRegistry } from "react-native";
import type * as SkiaNamespace from "@shopify/react-native-skia";

export type SkiaModule = typeof SkiaNamespace;

let skia: SkiaModule | null | undefined;

/** Skia when the native module is in this build, else null; callers keep a View fallback. */
export function loadSkia(): SkiaModule | null {
  if (skia !== undefined) return skia;
  // Probe the native side first: requiring the JS package on a client built without Skia leaves
  // a half-initialized module behind instead of throwing cleanly.
  if (TurboModuleRegistry.get("RNSkiaModule") === null) {
    skia = null;
    return skia;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
    const loaded = require("@shopify/react-native-skia") as Partial<SkiaModule>;
    skia = typeof loaded.Canvas === "function" && loaded.Skia !== undefined ? loaded : null;
  } catch {
    skia = null;
  }
  return skia;
}
