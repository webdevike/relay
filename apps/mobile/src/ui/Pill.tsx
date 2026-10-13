import { View } from "react-native";
import { Text } from "./Text";
import { radii, spacing, toneFill, useColors, type ToneToken } from "@/theme";

export interface PillProps {
  label: string;
  tone?: ToneToken;
}

export function Pill({ label, tone = "textMuted" }: PillProps) {
  const colors = useColors();
  return (
    <View
      style={{
        backgroundColor: toneFill(colors, tone),
        borderRadius: radii.sm,
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        alignSelf: "flex-start",
      }}
    >
      <Text variant="caption" color={tone === "textMuted" ? "textMuted" : tone}>
        {label}
      </Text>
    </View>
  );
}
