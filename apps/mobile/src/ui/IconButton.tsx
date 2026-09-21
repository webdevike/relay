import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { colors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { loadSkia } from "@/dictation/skia";

export interface IconButtonProps {
  symbol: SFSymbol;
  onPress: () => void;
  size?: number;
  tintColor?: string;
  disabled?: boolean;
  backgroundColor?: string;
}

/**
 * Round icon button. The disc is drawn with Skia when the build has it: a View circle from
 * `borderRadius` came out as a teardrop on iOS (one corner left square by Fabric), which no
 * combination of corner props fixed.
 */
export function IconButton({
  symbol,
  onPress,
  size = 40,
  tintColor = colors.text,
  disabled = false,
  backgroundColor = colors.surfaceRaised,
}: IconButtonProps) {
  const sk = loadSkia();
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      {sk === null ? (
        <View style={[StyleSheet.absoluteFill, { borderRadius: size / 2, backgroundColor }]} />
      ) : (
        <sk.Canvas style={StyleSheet.absoluteFill}>
          <sk.Circle cx={size / 2} cy={size / 2} r={size / 2} color={backgroundColor} />
        </sk.Canvas>
      )}
      <SymbolView name={symbol} size={size * 0.45} tintColor={tintColor} />
    </Pressable>
  );
}
