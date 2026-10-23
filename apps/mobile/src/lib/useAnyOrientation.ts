import { useEffect } from "react";
import { requireOptionalNativeModule } from "expo-modules-core";
import type * as ScreenOrientationModule from "expo-screen-orientation";

/**
 * Follow the phone (any orientation) while the calling screen is mounted; the rest of the app is
 * portrait. Guarded so a dev client built before expo-screen-orientation was added still loads.
 */
export function useAnyOrientation(): void {
  useEffect(() => {
    if (requireOptionalNativeModule("ExpoScreenOrientation") === null) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred so the native module stays optional
    const ScreenOrientation = require("expo-screen-orientation") as typeof ScreenOrientationModule;
    void ScreenOrientation.unlockAsync();
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);
}
