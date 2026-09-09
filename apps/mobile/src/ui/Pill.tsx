import { View } from "react-native";
import { Text } from "./Text";
import { colors, radii, spacing, type ColorToken } from "@/theme";

export interface PillProps {
  label: string;
  tone?: Extract<ColorToken, "accent" | "ok" | "warn" | "danger" | "textMuted">;
}

const backgroundFor: Record<NonNullable<PillProps["tone"]>, string> = {
  accent: "rgba(124,156,255,0.16)",
  ok: "rgba(74,222,128,0.16)",
  warn: "rgba(251,191,36,0.16)",
  danger: "rgba(248,113,113,0.16)",
  textMuted: colors.surfaceRaised,
};

export function Pill({ label, tone = "textMuted" }: PillProps) {
  return (
    <View
      style={{
        backgroundColor: backgroundFor[tone],
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
