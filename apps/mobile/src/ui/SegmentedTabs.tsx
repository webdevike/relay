import { Pressable, ScrollView, View } from "react-native";
import { radii, spacing, useColors } from "@/theme";
import { Text } from "@/ui/Text";

export interface SegmentedTabsProps<K extends string> {
  tabs: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  /** Many tabs: each keeps a minimum width and the track scrolls sideways instead of squeezing them. */
  scrollable?: boolean;
}

const SCROLL_TAB_MIN_WIDTH = 96;

/** A row of equal-width tabs on a raised track; the selected one sits on the surface. */
export function SegmentedTabs<K extends string>({
  tabs,
  value,
  onChange,
  scrollable = false,
}: SegmentedTabsProps<K>) {
  const colors = useColors();
  const track = (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: colors.surfaceRaised,
        borderRadius: radii.md,
        padding: 2,
      }}
    >
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
              flex: scrollable ? undefined : 1,
              minWidth: scrollable ? SCROLL_TAB_MIN_WIDTH : undefined,
              paddingHorizontal: scrollable ? spacing.md : undefined,
              alignItems: "center",
              justifyContent: "center",
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
  return scrollable ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {track}
    </ScrollView>
  ) : (
    track
  );
}
