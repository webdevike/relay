/**
 * The meeting cards of assistant `agent`'s chat, above the composer: one row each (the
 * assistant's face, the card line, the live clock or the notes' stage on the right), like the
 * guest work card. A live one carries a pulsing red dot and opens the full-screen meeting view;
 * an ended one opens the same screen, where the notes show once written.
 */
import { useEffect, useState } from "react";
import { Keyboard, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { meetingCardsFor, type MeetingRecording } from "@relay/protocol";
import { agentPortrait, agentTitle, useAssistantStore } from "@/state/assistant";
import { useMeetingsStore } from "@/state/meetings";
import { spacing, useColors, withAlpha } from "@/theme";
import { Portrait } from "@/ui/Portrait";
import { StatusCardRow } from "@/ui/StatusCardRow";
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
    <StatusCardRow
      // Desktop's ids for the same cards (the live card and the ended one are different cards).
      id={live ? `meeting:${recording.id}` : `meeting-ended:${recording.id}`}
      running={live}
      line={line}
      lineColor={live ? "text" : "textMuted"}
      accessibilityLabel={`Open the meeting: ${line}`}
      lead={
        <>
          <Portrait name={title} portrait={portrait} size={22} />
          {live ? <LiveDot /> : null}
        </>
      }
      meta={
        <Text variant="caption" color={!live && recording.stage === "done" ? "accent" : recording.stage === "failed" ? "danger" : "textMuted"} tabular>
          {meta}
        </Text>
      }
      borderColor={live ? withAlpha(colors.danger, 0.5) : colors.hairline}
      onOpen={() => {
        Keyboard.dismiss();
        router.push({ pathname: "/meetings/[id]", params: { id: recording.id, chat: agent } });
      }}
      style={styles.row}
      testID={live ? "meeting-card" : "meeting-ended"}
    />
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.xs, paddingBottom: spacing.xs },
  row: { marginHorizontal: spacing.lg },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
