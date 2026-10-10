import { Pressable, ScrollView, StyleSheet } from "react-native";
import type { AgentSession } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { StatusDot } from "@/ui/StatusDot";
import { radii, spacing, useColors } from "@/theme";

export interface SubagentChipsProps {
  subagents: readonly AgentSession[];
  onOpen: (sessionId: string) => void;
}

/**
 * The subagents a session spawned, pinned under its header: one chip each with a status dot, the
 * subagent's name, and what it is doing (or how it ended). Scrolls sideways when they overflow.
 */
export function SubagentChips({ subagents, onOpen }: SubagentChipsProps) {
  const colors = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.strip}
    >
      {subagents.map((subagent) => (
        <Pressable
          key={subagent.id}
          accessibilityRole="button"
          accessibilityLabel={`Open subagent ${subagent.title}`}
          onPress={() => {
            onOpen(subagent.id);
          }}
          style={({ pressed }) => [
            styles.chip,
            { backgroundColor: colors.surface, borderColor: colors.hairline },
            pressed && { opacity: 0.7 },
          ]}
        >
          <StatusDot status={subagent.status} size={7} />
          <Text variant="label" color="text" numberOfLines={1}>
            {subagent.title}
          </Text>
          {subagent.statusDetail !== undefined && (
            <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.detail}>
              {subagent.statusDetail}
            </Text>
          )}
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { marginTop: -spacing.sm, marginBottom: spacing.md },
  row: { paddingHorizontal: spacing.xl, gap: spacing.sm },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  detail: { maxWidth: 140 },
});
