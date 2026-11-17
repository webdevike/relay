import { StyleSheet, View } from "react-native";
import { agentBadge, type AgentRun } from "@relay/protocol";
import { IconButton } from "@/ui/IconButton";
import { OverlaySheet } from "@/ui/OverlaySheet";
import { Text } from "@/ui/Text";
import { spacing, useColors } from "@/theme";
import { RunDetail } from "./AgentsCaption";

/**
 * A specialist chip opened (`agents/RunningChips`): that run's details as the agents caption draws them (what was
 * asked, the answer, its sources, an error), live while it runs. `run` null keeps the sheet closed.
 */
export function SpecialistRunSheet({
  run,
  onClose,
}: {
  run: AgentRun | null;
  onClose: () => void;
}) {
  const colors = useColors();
  // The chip's own name for it: the trial letter (`Diagram B`) or the model it just switched to.
  const label = run === null ? "" : agentBadge(run, Date.now()).label;
  return (
    <OverlaySheet
      open={run !== null}
      onClose={onClose}
      header={
        <View style={[styles.head, { borderBottomColor: colors.hairline }]}>
          <Text variant="title" numberOfLines={1} style={styles.title}>
            {label}
          </Text>
          <IconButton
            symbol="xmark"
            size={34}
            accessibilityLabel={`Close ${label}`}
            onPress={onClose}
          />
        </View>
      }
    >
      {run !== null && (
        <View style={styles.body} testID="specialist-run-details">
          <RunDetail run={run} first />
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
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
});
