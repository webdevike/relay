import { ActivityIndicator, ScrollView, StyleSheet } from "react-native";
import { SymbolView } from "expo-symbols";
import { Chip } from "@/ui/Chip";
import type { RunningChip } from "@/lib/activity";
import { spacing, useColors } from "@/theme";

/**
 * What runs for an assistant thread right now (`lib/activity.ts` `runningChips`), one sideways row
 * of chips in the thread's header: a spinner while it works, a hand while it waits on Isaac. A chip
 * with a session opens that transcript (`onOpenSession`); the others open the Artifacts sheet's
 * Working group (`onOpenWorking`). Nothing renders when nothing runs.
 */
export function RunningChips({ chips, onOpenSession, onOpenWorking }: { chips: readonly RunningChip[]; onOpenSession: (sessionId: string) => void; onOpenWorking: () => void }) {
  const colors = useColors();
  if (chips.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.row}
      accessibilityRole="toolbar"
      accessibilityLabel="Running now"
    >
      {chips.map((chip) => (
        <Chip
          key={chip.id}
          label={chip.label}
          accessibilityLabel={chip.waiting ? `${chip.label}, waiting on you` : `${chip.label}, running`}
          leading={chip.waiting ? <SymbolView name="hand.raised" size={12} tintColor={colors.warn} /> : <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />}
          onPress={() => {
            if (chip.sessionId === undefined) onOpenWorking();
            else onOpenSession(chip.sessionId);
          }}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.lg },
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
});
