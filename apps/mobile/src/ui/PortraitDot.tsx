import { View, type StyleProp, type ViewStyle } from "react-native";
import type { DotTone } from "@relay/portrait-motion";
import { useColors } from "@/theme";

export interface PortraitDotProps {
  /** `@relay/portrait-motion` `statusDot`: the working accent, orange (needs Isaac), red (failed), or none. */
  tone: DotTone;
  size: number;
  /** The colour behind it, as a thin edge so it reads against the portrait. */
  edge: string;
  style?: StyleProp<ViewStyle>;
}

/** An assistant's status dot on the edge of its portrait; nothing when `tone` is null. */
export function PortraitDot({ tone, size, edge, style }: PortraitDotProps) {
  const colors = useColors();
  if (tone === null) return null;
  const fill = tone === "orange" ? colors.warn : tone === "red" ? colors.danger : colors.working;
  return (
    <View
      pointerEvents="none"
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: fill, borderWidth: Math.max(1.5, size * 0.18), borderColor: edge }, style]}
    />
  );
}
