import { Pressable, StyleSheet, View } from "react-native";
import type { AgentSession } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { StatusDot } from "@/ui/StatusDot";
import { spacing } from "@/theme";
import { AgentScrubber } from "./AgentScrubber";

export interface SubagentScrubberProps {
  /** The session that spawned them; slot one, so scrubbing back returns to it. */
  parent: AgentSession;
  subagents: readonly AgentSession[];
  /** Session the card shows now: the parent or one of its subagents. */
  selectedId: string;
  /** Scrubbing focuses that session in place on the card. */
  onSelect: (sessionId: string) => void;
  /** Tapping the label (or holding on a dot) opens the subagent full screen. */
  onOpen: (sessionId: string) => void;
}

/**
 * A session and its subagents as a scrubber under the header: the same track as the session
 * scrubber at the bottom, one dot per entry coloured by status. Scrubbing switches the card to
 * that entry; the row under the track names it with what it is doing.
 */
export function SubagentScrubber({ parent, subagents, selectedId, onSelect, onOpen }: SubagentScrubberProps) {
  const entries = [parent, ...subagents];
  const index = Math.max(0, entries.findIndex((entry) => entry.id === selectedId));
  const selected = entries[index] ?? parent;
  const isParent = selected.id === parent.id;

  return (
    <View style={styles.strip}>
      <AgentScrubber
        statuses={entries.map((entry) => entry.status)}
        index={index}
        divider={1}
        onChange={(i) => {
          const entry = entries[i];
          if (entry !== undefined) onSelect(entry.id);
        }}
        onLongPress={(i) => {
          const entry = entries[i];
          if (entry !== undefined && entry.id !== parent.id) onOpen(entry.id);
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isParent ? "Main session" : `Open subagent ${selected.title}`}
        disabled={isParent}
        onPress={() => {
          onOpen(selected.id);
        }}
        style={({ pressed }) => [styles.label, pressed && { opacity: 0.7 }]}
      >
        <StatusDot status={selected.status} size={7} />
        <Text variant="label" color="text" numberOfLines={1}>
          {isParent ? "Main" : selected.title}
        </Text>
        {!isParent && selected.statusDetail !== undefined && (
          <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.detail}>
            {selected.statusDetail}
          </Text>
        )}
        <Text variant="caption" color="textFaint">
          {isParent ? `${subagents.length} subagents` : `${index}/${subagents.length}`}
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
