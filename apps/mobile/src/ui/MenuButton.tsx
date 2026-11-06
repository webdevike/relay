import { Pressable } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { spacing, useColors, type ColorToken } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { Text } from "./Text";

export interface MenuButtonProps {
  label: string;
  onPress: () => void;
  /** A glyph before the label. */
  symbol?: SFSymbol | undefined;
  /** Label and glyph color; the text color by default. */
  color?: ColorToken | undefined;
  /** Label and glyph in white, for dark media chrome. */
  overlay?: boolean | undefined;
  disabled?: boolean | undefined;
  accessibilityLabel?: string | undefined;
}

/** A quiet borderless picker trigger: optional glyph, the current choice and a small chevron; opens a menu or sheet. */
export function MenuButton({ label, onPress, symbol, color = "text", overlay = false, disabled = false, accessibilityLabel }: MenuButtonProps) {
  const colors = useColors();
  const tint = overlay ? "#FFFFFF" : colors[color];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: spacing.xs, height: 28, paddingHorizontal: spacing.sm, borderRadius: 14, maxWidth: 200, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      {symbol !== undefined && <SymbolView name={symbol} size={14} tintColor={tint} />}
      <Text variant="label" numberOfLines={1} style={{ color: tint, flexShrink: 1 }}>
        {label}
      </Text>
      <SymbolView name="chevron.down" size={10} weight="semibold" tintColor={tint} />
    </Pressable>
  );
}
