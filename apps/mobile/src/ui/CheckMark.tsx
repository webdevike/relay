import { View } from "react-native";
import { SymbolView } from "expo-symbols";
import { radii, useColors } from "@/theme";

export interface CheckMarkProps {
  checked: boolean;
  size?: number;
}

/** The done/not-done box: a hairline square, filled in accent with a checkmark when done. */
export function CheckMark({ checked, size = 22 }: CheckMarkProps) {
  const colors = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: checked ? colors.accent : colors.hairline,
        borderRadius: radii.sm,
        backgroundColor: checked ? colors.accent : "transparent",
      }}
    >
      {checked && (
        <SymbolView
          name="checkmark"
          size={Math.round(size * 0.6)}
          weight="bold"
          tintColor={colors.bg}
        />
      )}
    </View>
  );
}
