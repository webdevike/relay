import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { EmptyState } from "@/ui/EmptyState";
import { Cutout, CUTOUT_GAP } from "@/ui/Cutout";
import { colors, motion, spacing } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { useConnectionStore } from "@/state/connection";
import { subscribeAgent, unsubscribeAgent } from "@/connection";
import { DictationButton } from "@/dictation/DictationButton";
import { ListeningOrb } from "@/dictation/ListeningOrb";
import { resetDictationTarget, setDictationTarget } from "@/dictation/deliver";
import { AgentCard } from "@/agents/AgentCard";
import { AgentScrubber, TRACK_HEIGHT } from "@/agents/AgentScrubber";

const MIC_SIZE = 60;
const CARD_RADIUS = 28;
/** How far the outgoing/incoming card content travels sideways during a session switch. */
const SLIDE_PX = 28;
/** Room the mic needs above the scrubber track; the panel's fixed height keeps the seam math static. */
const PANEL_TOP = MIC_SIZE / 2 + CUTOUT_GAP + spacing.md;
const PANEL_HEIGHT = PANEL_TOP + TRACK_HEIGHT + spacing.md + 16 + spacing.lg;

const slideIn = (direction: number): EntryExitAnimationFunction => () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateX: SLIDE_PX * direction }] },
    animations: {
      opacity: withTiming(1, { duration: motion.duration.base }),
      transform: [{ translateX: withTiming(0, { duration: motion.duration.base }) }],
    },
  };
};

const slideOut = (direction: number): EntryExitAnimationFunction => () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateX: 0 }] },
    animations: {
      opacity: withTiming(0, { duration: motion.duration.fast }),
      transform: [{ translateX: withTiming(-SLIDE_PX * direction, { duration: motion.duration.fast }) }],
    },
  };
};

/**
 * Every coding-agent session on the host, one at a time: a card shows the focused session, the
 * scrubber below picks which one, and the mic on the seam dictates into it.
 */
export default function AgentInbox() {
  const order = useAgentsStore((state) => state.order);
  const sessions = useAgentsStore((state) => state.sessions);
  const conversations = useAgentsStore((state) => state.conversations);
  const connected = useConnectionStore((state) => state.status === "connected");

  // Selection sticks to a session id, not a slot, so re-sorting never silently changes the focus.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selectedId = pickedId !== null && pickedId in sessions ? pickedId : order[0];
  const index = selectedId === undefined ? -1 : order.indexOf(selectedId);
  const lastIndex = useRef(index);
  const direction = index >= lastIndex.current ? 1 : -1;
  lastIndex.current = index;

  const session = selectedId === undefined ? undefined : sessions[selectedId];
  const messages = selectedId === undefined ? undefined : conversations[selectedId]?.messages;

  // Subscriptions live on the socket: re-subscribe whenever focus or the connection changes.
  useFocusEffect(
    useCallback(() => {
      if (!connected || selectedId === undefined) return;
      subscribeAgent(selectedId);
      return () => {
        unsubscribeAgent(selectedId);
      };
    }, [selectedId, connected]),
  );

  useFocusEffect(
    useCallback(() => {
      if (selectedId === undefined) return;
      setDictationTarget({ kind: "agent", sessionId: selectedId });
      return () => {
        resetDictationTarget();
      };
    }, [selectedId]),
  );

  const onScrub = useCallback(
    (next: number) => {
      const id = useAgentsStore.getState().order[next];
      if (id !== undefined) setPickedId(id);
    },
    [],
  );

  const canRespond = session?.canRespond === true;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.card}>
        {session === undefined ? (
          <EmptyState symbol="tray" title="No agent sessions" body="Sessions show up here while omp is running on your host." />
        ) : (
          <Animated.View key={session.id} style={StyleSheet.absoluteFill} entering={slideIn(direction)} exiting={slideOut(direction)}>
            <AgentCard session={session} messages={messages} connected={connected} />
          </Animated.View>
        )}
        <ListeningOrb />
      </View>
      {session !== undefined && (
        <View style={styles.panel}>
          {canRespond ? (
            <Cutout size={MIC_SIZE} style={styles.mic}>
              <DictationButton size={MIC_SIZE} backgroundColor={colors.surface} />
            </Cutout>
          ) : (
            <View style={styles.banner}>
              <Banner tone="warn" message="This session can't take replies." />
            </View>
          )}
          <AgentScrubber statuses={order.map((id) => sessions[id]?.status ?? "ended")} index={index} onChange={onScrub} />
          <Text variant="caption" color="textFaint" tabular style={styles.counter}>
            {index + 1} of {order.length}
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  card: {
    flex: 1,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  panel: {
    height: PANEL_HEIGHT,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    paddingTop: PANEL_TOP,
    paddingHorizontal: spacing.lg,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceRaised,
  },
  mic: {
    alignSelf: "center",
    // Outer ring centered on the seam: half the gap above the panel's top edge.
    top: -(MIC_SIZE / 2 + CUTOUT_GAP + spacing.sm / 2),
  },
  banner: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    top: spacing.sm,
  },
  counter: { textAlign: "center", marginTop: spacing.md },
});
