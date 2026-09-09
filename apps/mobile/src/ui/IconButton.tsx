import { Pressable } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { colors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

export interface IconButtonProps {
  symbol: SFSymbol;
  onPress: () => void;
  size?: number;
  tintColor?: string;
  disabled?: boolean;
  backgroundColor?: string;
}

export function IconButton({ symbol, onPress, size = 40, tintColor = colors.text, disabled = false, backgroundColor = colors.surfaceRaised }: IconButtonProps) {
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
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor,
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <SymbolView name={symbol} size={size * 0.45} tintColor={tintColor} />
    </Pressable>
  );
}
