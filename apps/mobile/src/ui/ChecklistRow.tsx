import { Pressable } from "react-native";
import { tapHaptic } from "@/lib/haptics";
import { spacing } from "@/theme";
import { CheckMark } from "./CheckMark";
import { Text } from "./Text";

export interface ChecklistRowProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** A full-width checkable row for shopping lists and task lists. */
export function ChecklistRow({ label, checked, onChange }: ChecklistRowProps) {
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
      <CheckMark checked={checked} />
      <Text
        color={checked ? "textMuted" : "text"}
        style={checked ? { textDecorationLine: "line-through" } : undefined}
      >
        {label}
      </Text>
    </Pressable>
  );
}
