import { View } from "react-native";
import { Text } from "./Text";
import { Button } from "./Button";
import { radii, spacing, toneFill, useColors, type ToneToken } from "@/theme";

export type BannerTone = "info" | "warn" | "danger";

export interface BannerProps {
  tone: BannerTone;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

const toneColor: Record<BannerTone, ToneToken> = {
  info: "accent",
  warn: "warn",
  danger: "danger",
};

export function Banner({ tone, message, actionLabel, onAction }: BannerProps) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        backgroundColor: toneFill(colors, toneColor[tone], 0.12),
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
