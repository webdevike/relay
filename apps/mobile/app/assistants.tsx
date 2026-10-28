/**
 * The Assistants list (`/assistants`): every agent in the host's registry as one flat divided
 * list, so a growing set of 24/7 agents stays scannable. Each row shows who the agent is, what it
 * covers, its last reply with how long ago, and where its thread stands. A tap opens the thread
 * (`/eva?agent=<id>`). The host owns all of it (`useAssistantStore().agents`): the screen asks
 * again whenever it gains focus, and the host pushes a fresh list when a status or reply changes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { AssistantAgent, AssistantStatus } from "@relay/protocol";
import { EmptyState } from "@/ui/EmptyState";
import { Pill } from "@/ui/Pill";
import { Screen } from "@/ui/Screen";
import { BreathingPortrait } from "@/ui/BreathingPortrait";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { requestAssistantAgents } from "@/connection";
import { previewText } from "@/agents/markdown";
import { relativeTime } from "@/lib/format";
import { portraitOf } from "@/lib/portrait";
import { tapHaptic } from "@/lib/haptics";
import { STATUS_LABEL, useAssistantStore } from "@/state/assistant";
import { useAgentsStore } from "@/state/agents";
import { useSettingsStore } from "@/state/settings";
import { orderAssistants } from "@/lib/profile";
import { spacing, useColors, type ToneToken } from "@/theme";

const AVATAR = 40;
/** Relative times only move by the minute; a half-minute tick keeps them honest on a screen left open. */
const TICK_MS = 30_000;

const statusTone: Record<AssistantStatus, ToneToken> = {
  working: "accent",
  needs_you: "warn",
  idle: "textMuted",
  not_started: "textMuted",
};

export default function Assistants() {
  const router = useRouter();
  const registry = useAssistantStore((state) => state.agents);
  const sessions = useAgentsStore((state) => state.sessions);
  const profile = useSettingsStore((state) => state.ompProfile);
  // The active account's assistants lead (home's Work | Personal switch), read off the sessions they run in.
  const agents = useMemo(() => (registry === null ? null : orderAssistants(registry, sessions, profile)), [registry, sessions, profile]);
  const [now, setNow] = useState(() => Date.now());

  useFocusEffect(
    useCallback(() => {
      requestAssistantAgents();
      setNow(Date.now());
    }, []),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <Screen title="Assistants">
      <Text variant="body" color="textMuted" style={styles.subtext}>
        Assistants that work in the background and text you when something needs you.
      </Text>
      {agents === null || agents.length === 0 ? (
        <EmptyState
          symbol="bubble.left.and.text.bubble.right"
          title={agents === null ? "No assistants yet" : "No assistants on this host"}
          body={agents === null ? "They appear here once your host is connected." : "Add one to the host's registry and restart the host."}
        />
      ) : (
        <FlatList
          data={agents}
          keyExtractor={(agent) => agent.id}
          ItemSeparatorComponent={Separator}
          ListHeaderComponent={Separator}
          ListFooterComponent={Separator}
          renderItem={({ item }) => (
            <AssistantRow
              agent={item}
              now={now}
              onPress={() => {
                router.push({ pathname: "/eva", params: { agent: item.id } });
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}

function AssistantRow({ agent, now, onPress }: { agent: AssistantAgent; now: number; onPress: () => void }) {
  const colors = useColors();
  const reply = agent.lastReply === undefined ? "" : previewText(agent.lastReply.text);
  const status = agent.status;
  const label = [agent.title, status === undefined ? null : STATUS_LABEL[status], reply === "" ? null : reply].filter((part) => part !== null).join(". ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({ backgroundColor: pressed ? colors.surfaceRaised : "transparent" })}
    >
      <View style={styles.row}>
        <BreathingPortrait name={agent.title} portrait={portraitOf(agent)} size={AVATAR} working={status === "working"} />
        <View style={styles.body}>
          <View style={styles.line}>
            <Text variant="title" numberOfLines={1} style={styles.grow}>
              {agent.title}
            </Text>
            {status !== undefined && <Pill label={STATUS_LABEL[status]} tone={statusTone[status]} />}
          </View>
          {agent.scope !== undefined && (
            <Text variant="caption" color="textMuted" numberOfLines={1}>
              {agent.scope}
            </Text>
          )}
          <View style={styles.line}>
            <Text variant="body" color={reply === "" ? "textFaint" : "textMuted"} numberOfLines={1} style={styles.grow}>
              {reply === "" ? "No messages yet" : reply}
            </Text>
            {agent.lastReply !== undefined && reply !== "" && (
              <Text variant="caption" color="textFaint" tabular>
                {relativeTime(agent.lastReply.at, now)}
              </Text>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The header leaves a gap for its own spacing; pulling the subtext up keeps heading and subtext one unit.
  subtext: { paddingHorizontal: spacing.xl, marginTop: -spacing.sm, paddingBottom: spacing.lg },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: 44,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  body: { flex: 1, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  grow: { flex: 1 },
});
