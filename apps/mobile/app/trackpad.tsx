import type { ReactNode } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useKeepAwake } from "expo-keep-awake";
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
        <View style={{ position: "absolute", right: spacing.xl, bottom: spacing.xl }}>{renderDictationButton()}</View>
      </View>
    </SafeAreaView>
  );
}
