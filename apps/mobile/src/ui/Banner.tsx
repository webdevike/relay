import { View } from "react-native";
import { Text } from "./Text";
import { Button } from "./Button";
import { radii, spacing, useScheme, type ColorScheme, type ColorToken } from "@/theme";

export type BannerTone = "info" | "warn" | "danger";

export interface BannerProps {
  tone: BannerTone;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

const toneColor: Record<BannerTone, ColorToken> = {
  info: "accent",
  warn: "warn",
  danger: "danger",
};

// Translucent tints of each tone's palette color.
const toneBackground: Record<ColorScheme, Record<BannerTone, string>> = {
  dark: {
    info: "rgba(124,156,255,0.12)",
    warn: "rgba(251,191,36,0.12)",
    danger: "rgba(248,113,113,0.12)",
  },
  light: {
    info: "rgba(61,95,224,0.12)",
    warn: "rgba(180,83,9,0.12)",
    danger: "rgba(220,38,38,0.12)",
  },
};

export function Banner({ tone, message, actionLabel, onAction }: BannerProps) {
  const scheme = useScheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        backgroundColor: toneBackground[scheme][tone],
        borderRadius: radii.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        marginHorizontal: spacing.xl,
      }}
    >
      <Text variant="label" color={toneColor[tone]} style={{ flex: 1 }}>
        {message}
      </Text>
      {actionLabel !== undefined && onAction !== undefined && (
        <Button label={actionLabel} onPress={onAction} variant="ghost" />
      )}
    </View>
  );
}
