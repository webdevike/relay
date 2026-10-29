import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Text } from "@/ui/Text";
import { radii, spacing, useColors } from "@/theme";
import { ownedBy, useAgentsStore } from "@/state/agents";
import { tapHaptic } from "@/lib/haptics";

/** Height of the row, for the thread to start its list below it. */
export const OWNED_ROW_HEIGHT = 40;

/**
 * The sessions an assistant started for its own work (Astra's `<KEY> auto-work`), under its
 * avatar instead of in the Agent Inbox: a pill per session, newest activity first. A tap opens
 * the session screen pinned to it, whose back row returns here. Renders nothing when there are none.
 */
export function OwnedSessions({ agent, sessionIds }: { agent: string; sessionIds: readonly string[] }) {
  const colors = useColors();
  const router = useRouter();
  const sessions = useAgentsStore((state) => state.sessions);
  if (sessionIds.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.row} contentContainerStyle={styles.content} accessibilityLabel={`Sessions ${agent} started`}>
      {sessionIds.map((id) => {
        const session = sessions[id];
        if (session === undefined) return null;
        const working = session.status === "working";
        return (
          <Pressable
            key={id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${session.title}`}
            onPress={() => {
              tapHaptic();
              router.push({ pathname: "/agents/[sessionId]", params: { sessionId: id } });
            }}
            style={({ pressed }) => [styles.pill, { backgroundColor: colors.surface, borderColor: colors.hairline }, pressed && { opacity: 0.7 }]}
          >
            {working ? <View style={[styles.dot, { backgroundColor: colors.accent }]} /> : null}
            <Text variant="label" color={working ? "text" : "textMuted"} numberOfLines={1}>
              {session.title.replace(/ auto-work$/, "")}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** The ids `OwnedSessions` shows for `agent`, kept stable while nothing about them changes. */
export function useOwnedSessionIds(agent: string): string {
  return useAgentsStore((state) => ownedBy(state.sessions, agent).map((session) => session.id).join(" "));
}

const styles = StyleSheet.create({
  row: { alignSelf: "stretch", flexGrow: 0, height: OWNED_ROW_HEIGHT, marginTop: spacing.xs },
  content: { alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  pill: { flexDirection: "row", alignItems: "center", gap: spacing.xs, height: 30, paddingHorizontal: spacing.md, borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
