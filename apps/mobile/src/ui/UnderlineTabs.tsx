import { Pressable, ScrollView, View } from "react-native";
import { spacing, useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { Text } from "@/ui/Text";

export interface UnderlineTabsProps<K extends string> {
  /** `count` shows muted after the label ("Files 12"). */
  tabs: readonly { key: K; label: string; count?: number | undefined }[];
  value: K;
  onChange: (key: K) => void;
}

/**
 * Content-width text tabs over a full-width hairline, the selected one in full text color with a
 * short bar under it (a page's sections, e.g. a PR's Conversation / Files / Checks / Guide).
 * Scrolls sideways when the labels outgrow the width.
 */
export function UnderlineTabs<K extends string>({ tabs, value, onChange }: UnderlineTabsProps<K>) {
  const colors = useColors();
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.hairline }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: spacing.xl }}>
        {tabs.map((tab) => {
          const selected = tab.key === value;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={tab.count === undefined ? tab.label : `${tab.label}, ${String(tab.count)}`}
              testID={`tab-${tab.key}`}
              hitSlop={{ top: 8, bottom: 4 }}
              onPress={() => {
                tapHaptic();
                onChange(tab.key);
              }}
              style={{ paddingTop: spacing.sm, paddingBottom: spacing.md - 2 }}
            >
              <Text variant="body" color={selected ? "text" : "textMuted"} style={{ fontWeight: "500" }} numberOfLines={1}>
                {tab.label}
                {tab.count !== undefined && <Text variant="body" color="textFaint" style={{ fontWeight: "400" }}>{` ${String(tab.count)}`}</Text>}
              </Text>
              <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, borderRadius: 1, backgroundColor: selected ? colors.text : "transparent" }} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
