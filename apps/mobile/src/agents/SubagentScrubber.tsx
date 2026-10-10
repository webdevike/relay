import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { AgentSession } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { StatusDot } from "@/ui/StatusDot";
import { spacing } from "@/theme";
import { AgentScrubber } from "./AgentScrubber";

export interface SubagentScrubberProps {
  subagents: readonly AgentSession[];
  onOpen: (sessionId: string) => void;
}

/**
 * The subagents a session spawned, as a scrubber under its header: the same track as the session
 * scrubber at the bottom, one dot per subagent coloured by status. Scrubbing picks one and the row
 * under the track names it with what it is doing; tapping that row (or holding on a dot) opens it.
 */
export function SubagentScrubber({ subagents, onOpen }: SubagentScrubberProps) {
  const [index, setIndex] = useState(0);
  const count = subagents.length;
  // Subagents only ever get appended, but a parent switch can shrink the list under the selection.
  useEffect(() => {
    if (index >= count) setIndex(Math.max(0, count - 1));
  }, [index, count]);
  const selected = subagents[Math.min(index, count - 1)];
  if (selected === undefined) return null;

  return (
    <View style={styles.strip}>
      <AgentScrubber
        statuses={subagents.map((subagent) => subagent.status)}
        index={Math.min(index, count - 1)}
        onChange={setIndex}
        onLongPress={(i) => {
          const subagent = subagents[i];
          if (subagent !== undefined) onOpen(subagent.id);
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open subagent ${selected.title}`}
        onPress={() => {
          onOpen(selected.id);
        }}
        style={({ pressed }) => [styles.label, pressed && { opacity: 0.7 }]}
      >
        <StatusDot status={selected.status} size={7} />
        <Text variant="label" color="text" numberOfLines={1}>
          {selected.title}
        </Text>
        {selected.statusDetail !== undefined && (
          <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.detail}>
            {selected.statusDetail}
          </Text>
        )}
        <Text variant="caption" color="textFaint">
          {`${Math.min(index, count - 1) + 1}/${count}`}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { marginTop: -spacing.sm, marginBottom: spacing.md, paddingHorizontal: spacing.xl, gap: spacing.xs },
  label: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xs },
  detail: { flexShrink: 1 },
});
