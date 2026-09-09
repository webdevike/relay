import { ActivityIndicator, Pressable } from "react-native";
import { Text } from "./Text";
import { colors, radii, spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
}

const backgroundFor: Record<ButtonVariant, string> = {
  primary: colors.accent,
  secondary: colors.surfaceRaised,
  ghost: "transparent",
};

const textColorFor: Record<ButtonVariant, "bg" | "text" | "accent"> = {
  primary: "bg",
  secondary: "text",
  ghost: "accent",
};

export function Button({ label, onPress, variant = "primary", disabled = false, loading = false }: ButtonProps) {
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        height: 36,
        borderRadius: radii.md,
        paddingHorizontal: spacing.lg,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: backgroundFor[variant],
        opacity: disabled || loading ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? colors.bg : colors.text} />
      ) : (
        <Text variant="label" color={textColorFor[variant]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
