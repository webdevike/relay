import { Pressable, View } from "react-native";
import { Card } from "./Card";
import { Text } from "./Text";
import { spacing, useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

export interface Suggestion {
  key: string;
  /** What picking it inserts, shown as typed (`/handoff`). */
  title: string;
  /** Muted note beside the title: what comes after it (`[focus instructions]`). */
  hint?: string | undefined;
  /** One muted line under the title. */
  detail?: string | undefined;
}

export interface SuggestionListProps {
  suggestions: readonly Suggestion[];
  onPick: (key: string) => void;
}

/**
 * Autocomplete choices floating over a field, in a raised card: one hairline-separated row each
 * with a title, an optional hint beside it and a detail line under it. The caller positions it.
 */
export function SuggestionList({ suggestions, onPick }: SuggestionListProps) {
  const colors = useColors();
  return (
    <Card>
      {suggestions.map((suggestion, index) => (
        <Pressable
          key={suggestion.key}
          accessibilityRole="button"
          accessibilityLabel={suggestion.title}
          onPress={() => {
            tapHaptic();
            onPick(suggestion.key);
          }}
          style={({ pressed }) => ({
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            borderTopWidth: index === 0 ? 0 : 1,
            borderTopColor: colors.hairline,
            backgroundColor: pressed ? colors.surface : "transparent",
          })}
        >
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
            <Text variant="label" color="text" numberOfLines={1} style={{ flexShrink: 1 }}>
              {suggestion.title}
            </Text>
            {suggestion.hint !== undefined && suggestion.hint.length > 0 && (
              <Text variant="caption" color="textFaint" numberOfLines={1} style={{ flexShrink: 1 }}>
                {suggestion.hint}
              </Text>
            )}
          </View>
          {suggestion.detail !== undefined && suggestion.detail.length > 0 && (
            <Text variant="caption" color="textMuted" numberOfLines={1}>
              {suggestion.detail}
            </Text>
          )}
        </Pressable>
      ))}
    </Card>
  );
}
