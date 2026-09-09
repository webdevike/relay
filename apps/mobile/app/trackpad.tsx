import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useKeepAwake } from "expo-keep-awake";
import { requireOptionalNativeModule } from "expo-modules-core";
import type * as ScreenOrientationModule from "expo-screen-orientation";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconButton } from "@/ui/IconButton";
import { colors, spacing } from "@/theme";
import { TrackpadSurface } from "@/trackpad/TrackpadSurface";
import { DictationButton } from "@/dictation/DictationButton";

export interface TrackpadScreenProps {
  /**
   * Lazily swappable dictation slot. Defaults to the real `DictationButton`; a caller (or a
   * future test) can override it, and if `@/dictation/DictationButton` had not landed yet this
   * default would fall back to the foundation's `IconButton` placeholder instead.
   */
  renderDictationButton?: () => ReactNode;
}

const defaultDictationButton = (): ReactNode => <DictationButton />;

/** Edge-to-edge trackpad: full-bleed gesture surface, ghost back chevron, floating dictation. */
export default function TrackpadScreen({ renderDictationButton = defaultDictationButton }: TrackpadScreenProps) {
  useKeepAwake();
  const router = useRouter();

  useEffect(() => {
    // Follow the phone (any orientation) while the trackpad is up; the rest of the app is portrait.
    // Guarded so a dev client built before expo-screen-orientation was added still loads.
    if (requireOptionalNativeModule("ExpoScreenOrientation") === null) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred so the import above stays optional
    const ScreenOrientation = require("expo-screen-orientation") as typeof ScreenOrientationModule;
    void ScreenOrientation.unlockAsync();
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top", "bottom", "left", "right"]}>
      <StatusBar hidden />
      <View style={{ flex: 1 }}>
        <TrackpadSurface />
        <View style={{ position: "absolute", top: spacing.md, left: spacing.md }}>
          <IconButton
            symbol="chevron.left"
            size={32}
            tintColor={colors.textMuted}
            onPress={() => {
              router.back();
            }}
          />
        </View>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: spacing.lg, alignItems: "center" }}>
          {renderDictationButton()}
        </View>
      </View>
    </SafeAreaView>
  );
}
