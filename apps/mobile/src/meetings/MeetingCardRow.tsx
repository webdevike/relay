/**
 * The meeting cards of assistant `agent`'s chat, above the composer: one row each (the
 * assistant's face, the card line, the live clock or the notes' stage on the right), like the
 * guest work card. A live one carries a pulsing red dot and opens the full-screen meeting view;
 * an ended one opens the same screen, where the notes show once written.
 */
import { useEffect, useState } from "react";
import { Keyboard, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { meetingCardsFor, type MeetingRecording } from "@relay/protocol";
import { tapHaptic } from "@/lib/haptics";
import { agentPortrait, agentTitle, useAssistantStore } from "@/state/assistant";
import { useMeetingsStore } from "@/state/meetings";
import { spacing, radii, useColors, withAlpha } from "@/theme";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";
import { meetingCardLine, meetingCardMeta } from "./card";

export function MeetingCards({ agent }: { agent: string }) {
  const recordings = useMeetingsStore((s) => s.state?.recordings);
  const [now, setNow] = useState(() => Date.now());
  const cards = recordings === undefined ? [] : meetingCardsFor(recordings, agent, now);
  const anyLive = cards.some((card) => card.live);
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [anyLive]);
  if (cards.length === 0) return null;
  return (
    <View style={styles.stack}>
      {cards.map(({ recording, live }) => (
        <MeetingCardRow key={recording.id} agent={agent} recording={recording} live={live} now={now} />
      ))}
    </View>
  );
}

function LiveDot() {
  const colors = useColors();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.3, { duration: 900, reduceMotion: ReduceMotion.System }), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, { backgroundColor: colors.danger }, style]} />;
}

function MeetingCardRow({ agent, recording, live, now }: { agent: string; recording: MeetingRecording; live: boolean; now: number }) {
  const router = useRouter();
  const colors = useColors();
  const title = useAssistantStore((state) => agentTitle(state.agents, agent));
  const portrait = useAssistantStore((state) => agentPortrait(state.agents, agent));
  const line = meetingCardLine(recording, live);
  const meta = meetingCardMeta(recording, live, now);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open the meeting: ${line}`}
      onPress={() => {
        tapHaptic();
        Keyboard.dismiss();
        router.push({ pathname: "/meetings/[id]", params: { id: recording.id, chat: agent } });
      }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: colors.surfaceRaised, borderColor: live ? withAlpha(colors.danger, 0.5) : colors.hairline, opacity: pressed ? 0.7 : 1 },
      ]}
      testID={live ? "meeting-card" : "meeting-ended"}
    >
      <Portrait name={title} portrait={portrait} size={22} />
      {live ? <LiveDot /> : null}
      <Text variant="body" color={live ? "text" : "textMuted"} numberOfLines={1} style={styles.line}>
        {line}
      </Text>
      <Text variant="caption" color={!live && recording.stage === "done" ? "accent" : recording.stage === "failed" ? "danger" : "textMuted"} tabular>
        {meta}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.xs, paddingBottom: spacing.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  line: { flex: 1, minWidth: 0 },
});
