import { ActivityIndicator, View } from "react-native";
import { Text } from "./Text";
import { Button } from "./Button";
import { radii, spacing, toneFill, useColors, type ToneToken } from "@/theme";

export type BannerTone = "info" | "warn" | "danger";

export interface BannerProps {
  tone: BannerTone;
  message: string;
  /** A muted second line under the message. */
  detail?: string | undefined;
  /** Leads with a spinner in the tone: something is in progress. */
  busy?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}

const toneColor: Record<BannerTone, ToneToken> = {
  info: "accent",
  warn: "warn",
  danger: "danger",
};

export function Banner({ tone, message, detail, busy = false, actionLabel, onAction }: BannerProps) {
  const colors = useColors();
  return (
    <View
      accessibilityLiveRegion="polite"
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
      {busy && <ActivityIndicator size="small" color={colors[toneColor[tone]]} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" color={toneColor[tone]}>
          {message}
        </Text>
        {detail !== undefined && detail.length > 0 && (
          <Text variant="caption" color="textMuted">
            {detail}
          </Text>
        )}
      </View>
      {actionLabel !== undefined && onAction !== undefined && (
        <Button label={actionLabel} onPress={onAction} variant="ghost" />
      )}
    </View>
  );
}
