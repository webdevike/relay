import { View } from "react-native";
import { Text } from "./Text";
import { radii, spacing, useColors, useScheme, type ColorScheme, type ColorToken } from "@/theme";

export interface PillProps {
  label: string;
  tone?: Extract<ColorToken, "accent" | "ok" | "warn" | "danger" | "textMuted">;
}

type TintTone = Exclude<NonNullable<PillProps["tone"]>, "textMuted">;

// Translucent tints of each tone's palette color; the muted tone sits on surfaceRaised instead.
const tintFor: Record<ColorScheme, Record<TintTone, string>> = {
  dark: {
    accent: "rgba(124,156,255,0.16)",
    ok: "rgba(74,222,128,0.16)",
    warn: "rgba(251,191,36,0.16)",
    danger: "rgba(248,113,113,0.16)",
  },
  light: {
    accent: "rgba(61,95,224,0.16)",
    ok: "rgba(21,128,61,0.16)",
    warn: "rgba(180,83,9,0.16)",
    danger: "rgba(220,38,38,0.16)",
  },
};

export function Pill({ label, tone = "textMuted" }: PillProps) {
  const colors = useColors();
  const scheme = useScheme();
  return (
    <View
      style={{
        backgroundColor: tone === "textMuted" ? colors.surfaceRaised : tintFor[scheme][tone],
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
