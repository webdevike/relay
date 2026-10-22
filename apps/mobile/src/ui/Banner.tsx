import { ActivityIndicator, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "./Text";
import { Button } from "./Button";
import { radii, spacing, toneFill, useColors, type ToneToken } from "@/theme";

export type BannerTone = "info" | "warn" | "danger";

export interface BannerProps {
  tone: BannerTone;
  message: string;
  /** A muted second line under the message. */
  detail?: string | undefined;
  /** Caps the detail at this many lines, ending in an ellipsis; unset shows all of it. */
  detailLines?: number;
  /** Leads with a spinner in the tone: something is in progress. */
  busy?: boolean;
  /** Leads with this glyph in the tone instead (a spinner wins while `busy`). */
  icon?: SFSymbol;
  actionLabel?: string;
  onAction?: () => void;
}

const toneColor: Record<BannerTone, ToneToken> = {
  info: "accent",
  warn: "warn",
  danger: "danger",
};

export function Banner({ tone, message, detail, detailLines, busy = false, icon, actionLabel, onAction }: BannerProps) {
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
      {busy ? (
        <ActivityIndicator size="small" color={colors[toneColor[tone]]} />
      ) : (
        icon !== undefined && <SymbolView name={icon} size={16} tintColor={colors[toneColor[tone]]} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" color={toneColor[tone]}>
          {message}
        </Text>
        {detail !== undefined && detail.length > 0 && (
          <Text variant="caption" color="textMuted" {...(detailLines === undefined ? {} : { numberOfLines: detailLines })}>
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
