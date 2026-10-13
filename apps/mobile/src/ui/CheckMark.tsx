import { View } from "react-native";
import { radii, useColors } from "@/theme";

export interface CheckMarkProps {
  checked: boolean;
  size?: number;
}

/** The done/not-done box: a hairline square, filled in accent with a small inner square when done. */
export function CheckMark({ checked, size = 22 }: CheckMarkProps) {
  const colors = useColors();
  const inner = Math.round(size * 0.36);
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
        <View style={{ width: inner, height: inner, borderRadius: 2, backgroundColor: colors.bg }} />
      )}
    </View>
  );
}
