import { ActivityIndicator, Pressable, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "./Text";
import { spacing, useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

const DISC = 44;
const OVERLAY_FILL = "rgba(255,255,255,0.12)";

export interface ToolbarButtonProps {
  symbol: SFSymbol;
  /** Short name under the glyph ("Remix", "Share"). */
  label: string;
  onPress: () => void;
  /** `overlay`: white on a translucent disc, for the black full-screen viewer. */
  tone?: "default" | "overlay";
  busy?: boolean;
  disabled?: boolean;
}

/** A 44pt round glyph with its name under it, one of a row of actions (the viewer's toolbar). */
export function ToolbarButton({ symbol, label, onPress, tone = "default", busy = false, disabled = false }: ToolbarButtonProps) {
  const colors = useColors();
  const overlay = tone === "overlay";
  const tint = overlay ? "#FFFFFF" : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({ alignItems: "center", gap: spacing.xs, width: 72, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}
    >
      <View style={{ width: DISC, height: DISC, borderRadius: DISC / 2, alignItems: "center", justifyContent: "center", backgroundColor: overlay ? OVERLAY_FILL : colors.surfaceRaised }}>
        {busy ? <ActivityIndicator color={tint} /> : <SymbolView name={symbol} size={20} tintColor={tint} />}
      </View>
      <Text variant="caption" numberOfLines={2} style={{ textAlign: "center", color: overlay ? "#FFFFFF" : colors.textMuted }}>
        {label}
      </Text>
    </Pressable>
  );
}
