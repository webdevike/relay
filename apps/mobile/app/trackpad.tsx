import { useEffect, type ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useKeepAwake } from "expo-keep-awake";
import { requireOptionalNativeModule } from "expo-modules-core";
import type * as ScreenOrientationModule from "expo-screen-orientation";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconButton } from "@/ui/IconButton";
import { colors } from "@/theme";
import { SURFACE_MARGIN, TrackpadSurface } from "@/trackpad/TrackpadSurface";
import { DictationButton } from "@/dictation/DictationButton";

export interface TrackpadScreenProps {
  /**
   * Lazily swappable dictation slot. Defaults to the real `DictationButton`; a caller (or a
   * future test) can override it, and if `@/dictation/DictationButton` had not landed yet this
   * default would fall back to the foundation's `IconButton` placeholder instead.
   */
  renderDictationButton?: () => ReactNode;
}

const BACK_SIZE = 40;
const MIC_SIZE = 60;
const CUTOUT_GAP = 4;
/** Back sits on the top edge, in from the corner, so it never crowds the screen edge. */
const BACK_INSET = 12;

const defaultDictationButton = (): ReactNode => <DictationButton size={MIC_SIZE} backgroundColor={colors.surface} />;

/** A ring of screen background around an edge button so it reads as carved out of the surface. */
function Cutout({ size, style, children }: { size: number; style: ViewStyle; children: ReactNode }) {
  const outer = size + CUTOUT_GAP * 2;
  return (
    <View
      style={[
        { position: "absolute", width: outer, height: outer, borderRadius: outer / 2, padding: CUTOUT_GAP, backgroundColor: colors.bg },
        style,
      ]}
    >
      {children}
    </View>
  );
}

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
        <Cutout size={BACK_SIZE} style={{ top: SURFACE_MARGIN - (BACK_SIZE + CUTOUT_GAP * 2) / 2, left: SURFACE_MARGIN + BACK_INSET }}>
          <IconButton
            symbol="chevron.left"
            size={BACK_SIZE}
            tintColor={colors.textMuted}
            backgroundColor={colors.surface}
            onPress={() => {
              router.back();
            }}
          />
        </Cutout>
        <Cutout size={MIC_SIZE} style={{ bottom: SURFACE_MARGIN - (MIC_SIZE + CUTOUT_GAP * 2) / 2, alignSelf: "center" }}>
          {renderDictationButton()}
        </Cutout>
      </View>
    </SafeAreaView>
  );
}
