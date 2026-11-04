import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useActivityStore } from "@/state/activity";
import { Chip } from "@/ui/Chip";
import { activityBadges } from "@/lib/activity";
import { spacing, useColors } from "@/theme";

/**
 * A chip per thing this assistant has in progress beyond its helpers (sessions, harnesses, canvas
 * rooms), above the composer: a spinner while it runs, a hand while it waits on Isaac. A tap opens
 * the Artifacts sheet on its Working group, where the rows say more. Nothing renders when idle.
 */
export function ActivityBadges({ thread, onPress }: { thread: string; onPress: () => void }) {
  const colors = useColors();
  const items = useActivityStore((state) => state.items);
  const { shown, more } = useMemo(() => activityBadges(items, thread), [items, thread]);
  if (shown.length === 0) return null;
  return (
    <View style={styles.row} accessibilityRole="toolbar" accessibilityLabel="Working now">
      {shown.map((badge) => (
        <Chip
          key={badge.id}
          label={badge.label}
          accessibilityLabel={badge.waiting ? `${badge.label}, waiting on you` : `${badge.label}, running`}
          leading={badge.waiting ? <SymbolView name="hand.raised" size={12} tintColor={colors.warn} /> : <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />}
          onPress={onPress}
        />
      ))}
      {more > 0 && <Chip label={`+${String(more)} more`} onPress={onPress} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
});
