import { Pressable, View } from "react-native";
import { tapHaptic } from "@/lib/haptics";
import { radii, spacing, useColors } from "@/theme";
import { Text } from "./Text";

export interface ChecklistRowProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** A full-width checkable row for shopping lists and task lists. */
export function ChecklistRow({ label, checked, onChange }: ChecklistRowProps) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => {
        tapHaptic();
        onChange(!checked);
      }}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        paddingVertical: spacing.sm,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: checked ? colors.accent : colors.hairline,
          borderRadius: radii.sm,
          backgroundColor: checked ? colors.accent : "transparent",
        }}
      >
        {checked && (
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colors.bg }} />
        )}
      </View>
      <Text
        color={checked ? "textMuted" : "text"}
        style={checked ? { textDecorationLine: "line-through" } : undefined}
      >
        {label}
      </Text>
    </Pressable>
  );
}
