import { View } from "react-native";

import { radii, spacing, useColors } from "@/theme";
import { Text } from "@/ui/Text";

/** Stand-in for media that cannot be shown: muted label, optionally centered in a sized frame. */
export function MediaPlaceholder({
  label,
  width,
  height,
}: {
  label: string;
  width?: number | undefined;
  height?: number | undefined;
}) {
  const colors = useColors();
  const text = (
    <Text variant="caption" color="textMuted">
      {label}
    </Text>
  );
  if (width === undefined || height === undefined) return text;
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radii.sm,
        backgroundColor: colors.surface,
        padding: spacing.md,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {text}
    </View>
  );
}
