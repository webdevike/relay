import { View, type ViewStyle } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { radii, spacing } from "@/theme";
import { Text } from "@/ui/Text";

export interface OverlayTagProps {
  label?: string | undefined;
  icon?: SFSymbol | undefined;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

const CORNERS: Record<OverlayTagProps["corner"], ViewStyle> = {
  "top-left": { top: spacing.xs, left: spacing.xs },
  "top-right": { top: spacing.xs, right: spacing.xs },
  "bottom-left": { bottom: spacing.xs, left: spacing.xs },
  "bottom-right": { bottom: spacing.xs, right: spacing.xs },
};

/** Small dark tag pinned to a corner of media (counts, badges, play hints). */
export function OverlayTag({ label, icon, corner }: OverlayTagProps) {
  const iconOnly = label === undefined && icon !== undefined;
  return (
    <View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          backgroundColor: "rgba(0,0,0,0.6)",
          borderRadius: radii.sm,
        },
        iconOnly ? { padding: 6 } : { paddingHorizontal: spacing.xs, paddingVertical: 2 },
        CORNERS[corner],
      ]}
    >
      {icon !== undefined && <SymbolView name={icon} size={12} tintColor="#FFFFFF" />}
      {label !== undefined && (
        <Text variant="caption" style={{ color: "#FFFFFF" }}>
          {label}
        </Text>
      )}
    </View>
  );
}
