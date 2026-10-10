import { Pressable, View } from "react-native";
import { radii, spacing, useColors } from "@/theme";
import { Text } from "@/ui/Text";

export interface SegmentedTabsProps<K extends string> {
  tabs: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
}

/** A row of equal-width tabs on a raised track; the selected one sits on the surface. */
export function SegmentedTabs<K extends string>({ tabs, value, onChange }: SegmentedTabsProps<K>) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", backgroundColor: colors.surfaceRaised, borderRadius: radii.md, padding: 2 }}>
      {tabs.map((tab) => {
        const selected = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              onChange(tab.key);
            }}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: spacing.xs + 2,
              borderRadius: radii.sm,
              backgroundColor: selected ? colors.surface : "transparent",
            }}
          >
            <Text variant="caption" color={selected ? "text" : "textMuted"} numberOfLines={1}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
