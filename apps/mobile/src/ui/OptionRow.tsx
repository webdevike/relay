import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { radii, spacing, useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

export interface OptionRowProps {
  label: string;
  description?: string | undefined;
  selected: boolean;
  /** Short accent note on the right ("Recommended", "Photo"). */
  badge?: string | undefined;
  onPress: () => void;
}

/** One selectable choice in a list: bordered row, accent-tinted while selected. */
export function OptionRow({ label, description, selected, badge, onPress }: OptionRowProps) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.hairline,
        // Selected: the accent at 0.12 opacity.
        backgroundColor: selected ? `${colors.accent}1F` : colors.surface,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="body" color={selected ? "accent" : "text"} style={{ flex: 1 }}>
          {label}
        </Text>
        {badge !== undefined && (
          <Text variant="caption" color="accent">
            {badge}
          </Text>
        )}
      </View>
      {description !== undefined && description.length > 0 && (
        <Text variant="caption" color="textMuted" style={{ marginTop: spacing.xs }}>
          {description}
        </Text>
      )}
    </Pressable>
  );
}
