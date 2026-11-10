import type { ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useColors, useScheme } from "@/theme";

const BLUR_INTENSITY = 90;

export interface FrostedBarProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * Edge-to-edge frosted chrome (an iOS navigation bar): the system chrome material blurs whatever
 * scrolls under it, light or dark with the scheme, with one hairline along its bottom edge. Lay it
 * absolutely over a scrolling page and pad the page by its height so the first rows start below it.
 */
export function FrostedBar({ children, style, onLayout }: FrostedBarProps) {
  const colors = useColors();
  const scheme = useScheme();
  return (
    <View onLayout={onLayout} style={[styles.bar, { borderBottomColor: colors.hairline }, style]}>
      <BlurView intensity={BLUR_INTENSITY} tint={scheme === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight"} style={StyleSheet.absoluteFill} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { overflow: "hidden", borderBottomWidth: StyleSheet.hairlineWidth },
});
