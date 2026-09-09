import { View } from "react-native";
import { Text } from "./Text";
import { Button } from "./Button";
import { radii, spacing, type ColorToken } from "@/theme";

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

const toneBackground: Record<BannerTone, string> = {
  info: "rgba(124,156,255,0.12)",
  warn: "rgba(251,191,36,0.12)",
  danger: "rgba(248,113,113,0.12)",
};

export function Banner({ tone, message, actionLabel, onAction }: BannerProps) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        backgroundColor: toneBackground[tone],
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
