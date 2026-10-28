import { ActivityIndicator, Pressable } from "react-native";
import { Text } from "./Text";
import { radii, spacing, useColors, type ColorToken, type Colors, type ToneToken } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  /** Tints the primary fill, or the label of a secondary or ghost button. */
  tone?: ToneToken | undefined;
  /** Overrides the default 36pt height (e.g. 44pt touch targets in a widget grid). */
  height?: number | undefined;
  /** VoiceOver label when it should say more than `label`. */
  accessibilityLabel?: string | undefined;
  testID?: string | undefined;
}

function backgroundFor(variant: ButtonVariant, colors: Colors, tone: ToneToken | undefined): string {
  switch (variant) {
    case "primary":
      return colors[tone ?? "accent"];
    case "ghost":
      return "transparent";
    case "secondary":
    case "danger":
      return colors.surfaceRaised;
  }
}

const textColorFor: Record<ButtonVariant, ColorToken> = {
  primary: "bg",
  secondary: "text",
  ghost: "accent",
  danger: "danger",
};

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  tone,
  height = 36,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  const colors = useColors();
  const textColor =
    tone === undefined || variant === "primary" || variant === "danger" ? textColorFor[variant] : tone;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      disabled={disabled || loading}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        height,
        borderRadius: radii.md,
        paddingHorizontal: spacing.lg,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: backgroundFor(variant, colors, tone),
        opacity: disabled || loading ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? colors.bg : colors.text} />
      ) : (
        <Text variant="label" color={textColor} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
