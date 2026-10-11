import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { AgentSession } from "@relay/protocol";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { StatusDot } from "@/ui/StatusDot";
import { radii, spacing, useColors } from "@/theme";

export interface SubagentsSheetProps {
  visible: boolean;
  subagents: readonly AgentSession[];
  onClose: () => void;
  onOpen: (sessionId: string) => void;
  /** Clears these subagents off the phone (finished ones; running ones are stopped first). */
  onClear: (sessionIds: string[]) => void;
}

/**
 * The subagents the focused session spawned, opened from the button right of the mic: one row
 * each with status, name and what it is doing. Tap a row to open it; the x clears one, and
 * "Clear finished" drops every subagent that is no longer running.
 */
export function SubagentsSheet({ visible, subagents, onClose, onOpen, onClear }: SubagentsSheetProps) {
  const colors = useColors();
  const finished = subagents.filter((s) => s.status !== "working").map((s) => s.id);
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={styles.head}>
        <Text variant="title" color="text">{`Subagents · ${subagents.length}`}</Text>
        {finished.length > 0 && (
          <Button
            label="Clear finished"
            variant="secondary"
            onPress={() => {
              onClear(finished);
            }}
          />
        )}
      </View>
      {subagents.map((subagent) => (
        <View key={subagent.id} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.hairline }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open subagent ${subagent.title}`}
            onPress={() => {
              onOpen(subagent.id);
            }}
            style={({ pressed }) => [styles.main, pressed && { opacity: 0.7 }]}
          >
            <StatusDot status={subagent.status} size={8} />
            <View style={styles.text}>
              <Text variant="label" color="text" numberOfLines={1}>
                {subagent.title}
              </Text>
              {subagent.statusDetail !== undefined && (
                <Text variant="caption" color="textMuted" numberOfLines={1}>
                  {subagent.statusDetail}
                </Text>
              )}
            </View>
            <SymbolView name="chevron.right" size={13} tintColor={colors.textFaint} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear subagent ${subagent.title}`}
            hitSlop={8}
            onPress={() => {
              onClear([subagent.id]);
            }}
            style={({ pressed }) => [styles.clear, pressed && { opacity: 0.6 }]}
          >
            <SymbolView name="xmark" size={13} tintColor={colors.textMuted} />
          </Pressable>
        </View>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    marginBottom: spacing.sm,
  },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md },
  text: { flex: 1, gap: 2 },
  clear: { padding: spacing.md },
});
