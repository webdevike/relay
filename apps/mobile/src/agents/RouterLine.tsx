import { Pressable, StyleSheet, View } from "react-native";
import type { AssistantMessage } from "@relay/protocol";
import { tapHaptic } from "@/lib/haptics";
import { routerRowOf } from "@/lib/routerRow";
import { spacing, useColors } from "@/theme";
import { RouteIcon } from "@/ui/RouteIcon";
import { Text } from "@/ui/Text";

/**
 * Eva's specialist router under Isaac's bubble (`lib/routerRow`): one quiet caption line in the specialist chips'
 * muted style, `Router: web-researcher · 0.86 · <why> · used`. The why truncates on one line, the mark stays.
 * A tap opens the whole decision (`RouterSheet`). Nothing for a row the router never judged.
 */
export function RouterLine({
  message,
  onOpen,
}: {
  message: Pick<AssistantMessage, "id" | "role" | "router">;
  onOpen: (messageId: string) => void;
}) {
  const colors = useColors();
  const view = routerRowOf(message);
  if (view === null) return null;
  const { head, why, mark } = view.parts;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={view.label}
      accessibilityHint="Shows the router's whole decision"
      hitSlop={8}
      onPress={() => {
        tapHaptic();
        onOpen(message.id);
      }}
      style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
      testID="router-line"
    >
      <RouteIcon size={11} color={colors.textMuted} />
      <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.fixed}>
        {head}
      </Text>
      {why !== undefined && (
        <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.why}>
          {` · ${why}`}
        </Text>
      )}
      {mark !== undefined && (
        <View style={styles.fixedMark}>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {` · ${mark}`}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-end",
    maxWidth: "88%",
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  fixed: { flexShrink: 0, marginLeft: 4 },
  why: { flexShrink: 1 },
  fixedMark: { flexShrink: 0, maxWidth: "60%" },
});
