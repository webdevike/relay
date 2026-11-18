import { StyleSheet, View } from "react-native";
import type { RouterTurn } from "@relay/protocol";
import { routerSheetOf } from "@/lib/routerRow";
import { spacing, useColors } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { OverlaySheet } from "@/ui/OverlaySheet";
import { Text } from "@/ui/Text";
import { CodeBlock } from "./CodeBlock";

/**
 * A router line opened (`agents/RouterLine`): the specialist router's whole decision for that message (agent,
 * confidence, why, alternatives, the suggested request, mode, threshold, latency, error) and the turn's outcome.
 * `turn` null keeps the sheet closed.
 */
export function RouterSheet({ turn, onClose }: { turn: RouterTurn | null; onClose: () => void }) {
  const colors = useColors();
  const sheet = turn === null ? null : routerSheetOf(turn);
  return (
    <OverlaySheet
      open={turn !== null}
      onClose={onClose}
      header={
        <View style={[styles.head, { borderBottomColor: colors.hairline }]}>
          <Text variant="title" numberOfLines={1} style={styles.title}>
            Specialist router
          </Text>
          <IconButton symbol="xmark" size={34} accessibilityLabel="Close specialist router" onPress={onClose} />
        </View>
      }
    >
      {sheet !== null && (
        <View style={styles.body} testID="router-details">
          {sheet.rows.map(([label, value]) => (
            <View key={label} style={styles.row}>
              <Text variant="caption" color="textMuted" style={styles.label}>
                {label}
              </Text>
              <Text variant="caption" style={styles.value}>
                {value}
              </Text>
            </View>
          ))}
          {sheet.request !== null && (
            <View style={styles.request}>
              <Text variant="caption" color="textMuted">
                Suggested request
              </Text>
              <CodeBlock code={sheet.request} lang="json" />
            </View>
          )}
        </View>
      )}
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1 },
  body: { gap: spacing.xs, paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  row: { flexDirection: "row", gap: spacing.md },
  label: { width: 112 },
  value: { flex: 1 },
  request: { gap: spacing.xs, paddingTop: spacing.xs },
});
