import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
import { useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { useSharedValue, withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { EmptyState } from "@/ui/EmptyState";
import { Cutout, CUTOUT_GAP } from "@/ui/Cutout";
import { IconButton } from "@/ui/IconButton";
import { colors, motion, spacing } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { useConnectionStore } from "@/state/connection";
import { useSettingsStore } from "@/state/settings";
import { requestAgentOptions, sendCommand, subscribeAgent, unsubscribeAgent } from "@/connection";
import { DictationButton } from "@/dictation/DictationButton";
import { ListeningOrb } from "@/dictation/ListeningOrb";
import { SkillWheel, WHEEL_EXTENT } from "@/dictation/SkillWheel";
import { resetDictationTarget, setDictationTarget } from "@/dictation/deliver";
import { dictationActor } from "@/dictation/actor";
import { useDictation } from "@/dictation/useDictation";
import { AgentCard, AgentHeader } from "@/agents/AgentCard";
import { AgentScrubber, TRACK_HEIGHT } from "@/agents/AgentScrubber";
import { AgentSettingsSheet } from "@/agents/AgentSettingsSheet";
import { ActionWheel, type ActionWheelEntry } from "@/agents/ActionWheel";
import { impactHaptic, tapHaptic } from "@/lib/haptics";
import { copyText, readClipboardImage, readClipboardText } from "@/lib/clipboard";
import { warn } from "@/connection/log";

const MIC_SIZE = 60;
const CARD_RADIUS = 28;
/** The armed-skill notch on the seam between the header and the chat; taller when it holds thumbnails. */
const NOTCH_HEIGHT = 32;
const NOTCH_HEIGHT_WITH_CHIPS = 52;
/** Attachment thumbnails in the notch: a square this big, this far apart. */
const CHIP_SIZE = 40;
/** Holding still this long (ms) on the chat opens the action wheel; moving sooner scrolls instead. */
const WHEEL_HOLD_MS = 350;

const wheelEntries: ActionWheelEntry[] = [
  { key: "copy", label: "Copy", symbol: "doc.on.doc" },
  { key: "paste", label: "Paste", symbol: "doc.on.clipboard" },
];
/** How far the outgoing/incoming card content travels sideways during a session switch. */
const SLIDE_PX = 28;
/** Room the mic needs above the scrubber track; the panel's fixed height keeps the seam math static. */
const PANEL_TOP = MIC_SIZE / 2 + CUTOUT_GAP + spacing.md;
const PANEL_HEIGHT = PANEL_TOP + TRACK_HEIGHT + spacing.md + 16 + spacing.lg;
const START_SIZE = 36;
/** A launched omp normally registers within a few seconds; past this the spinner is a lie. */
const LAUNCH_TIMEOUT_MS = 20_000;

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
  // Without the wheel the button gets no skills, so the swipe left does nothing.
  const wheelEnabled = useSettingsStore((state) => state.skillWheelEnabled);
  const skills = useAgentsStore((state) => (!wheelEnabled || selectedId === undefined ? undefined : state.options[selectedId]?.skills));

  // Subscriptions live on the socket: re-subscribe whenever focus or the connection changes.
  useFocusEffect(
    useCallback(() => {
      if (!connected || selectedId === undefined) return;
      subscribeAgent(selectedId);
      // The skill wheel needs the session's skills before the first hold; the settings sheet
      // shares the same answer.
      requestAgentOptions(selectedId);
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

  // Starting a session: ack means the terminal opened; the session itself arrives as a delta a
  // few seconds later, and whichever id is new at that point becomes the focus.
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const knownIds = useRef(new Set(order));
  useEffect(() => {
    const fresh = order.filter((id) => !knownIds.current.has(id));
    knownIds.current = new Set(order);
    if (launching && fresh[0] !== undefined) {
      setPickedId(fresh[0]);
      setLaunching(false);
    }
  }, [order, launching]);
  useEffect(() => {
    if (!launching) return;
    const timer = setTimeout(() => {
      setLaunching(false);
      setLaunchError("The new session never showed up.");
    }, LAUNCH_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [launching]);
  const startSession = (): void => {
    setLaunchError(null);
    setLaunching(true);
    sendCommand({ kind: "agent.start" }).catch((error: unknown) => {
      setLaunching(false);
      setLaunchError(error instanceof Error ? error.message : "Couldn't start a session.");
    });
  };

  const canRespond = session?.canRespond === true;

  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const onHold = useCallback((slot: number) => {
    const id = useAgentsStore.getState().order[slot];
    if (id !== undefined) setSettingsFor(id);
  }, []);

  const { skill: armed, images } = useDictation();
  const [headerHeight, setHeaderHeight] = useState(0);

  // Holding still on the chat opens the action wheel under the finger. The Pan only activates
  // after the hold, so an early move is the transcript's scroll as usual; the wheel draws in the
  // stack's coordinates, so the chat card's offset (below the header) is mirrored for the worklets.
  const wheelVisible = useSharedValue(0);
  const wheelCenter = useSharedValue({ x: 0, y: 0 });
  const wheelPointer = useSharedValue({ x: 0, y: 0 });
  const chatTop = useSharedValue(0);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const onWheelSelect = useCallback((key: string) => {
    const sessionId = selectedRef.current;
    if (sessionId === undefined) return;
    if (key === "copy") {
      const messages = useAgentsStore.getState().conversations[sessionId]?.messages ?? [];
      let last: string | undefined;
      for (let i = messages.length - 1; i >= 0 && last === undefined; i -= 1) {
        const message = messages[i];
        if (message?.role === "assistant" && message.text !== "") last = message.text;
      }
      if (last === undefined) return;
      tapHaptic();
      void copyText(last);
      return;
    }
    // Paste: an image attaches to the next send; text goes straight into the session's editor.
    void (async () => {
      const image = await readClipboardImage();
      if (image !== null) {
        tapHaptic();
        dictationActor.send({ type: "attach", image });
        return;
      }
      const text = await readClipboardText();
      if (text === null) return;
      tapHaptic();
      await sendCommand({ kind: "agent.reply", sessionId, text, submit: false });
    })().catch((error: unknown) => {
      warn("agents", "paste failed", error);
    });
  }, []);
  const chatGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .activateAfterLongPress(WHEEL_HOLD_MS)
        .shouldCancelWhenOutside(false)
        .onStart((event) => {
          const at = { x: event.x, y: chatTop.value + event.y };
          wheelCenter.value = at;
          wheelPointer.value = at;
          wheelVisible.value = 1;
          scheduleOnRN(impactHaptic, "heavy");
        })
        .onUpdate((event) => {
          wheelPointer.value = { x: event.x, y: chatTop.value + event.y };
        })
        .onEnd(() => {
          wheelVisible.value = 0;
        })
        .onFinalize((_event, success) => {
          if (success) return;
          // Cancelled by the system: shut the wheel with nothing picked.
          wheelPointer.value = wheelCenter.value;
          wheelVisible.value = 0;
        }),
    [chatTop, wheelCenter, wheelPointer, wheelVisible],
  );

  const notchShown = (armed !== null || images.length > 0) && headerHeight > 0;
  const notchHeight = images.length > 0 ? NOTCH_HEIGHT_WITH_CHIPS : NOTCH_HEIGHT;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.stack}>
        {session === undefined ? (
          <View style={[styles.card, styles.chat]}>
            <EmptyState
              symbol="tray"
              title="No agent sessions"
              body={connected ? "Start one here, or open omp on your host." : "Sessions show up here while omp is running on your host."}
              {...(connected && !launching ? { actionLabel: "Start a session", onAction: startSession } : {})}
            />
          </View>
        ) : (
          <Animated.View key={session.id} style={StyleSheet.absoluteFill} entering={slideIn(direction)} exiting={slideOut(direction)}>
            <View
              style={[styles.card, styles.header]}
              onLayout={(event) => {
                setHeaderHeight(event.nativeEvent.layout.height);
                chatTop.value = event.nativeEvent.layout.height + spacing.sm;
              }}
            >
              <AgentHeader session={session} />
            </View>
            <GestureDetector gesture={chatGesture}>
              <View style={[styles.card, styles.chat]}>
                <AgentCard sessionId={selectedId} messages={messages} connected={connected} />
              </View>
            </GestureDetector>
            {notchShown && (
              <Cutout size={notchHeight} width={notchWidth(armed, images.length)} style={{ alignSelf: "center", top: headerHeight + spacing.sm / 2 - notchHeight / 2 - CUTOUT_GAP }}>
                <View style={[styles.notchBody, { borderRadius: notchHeight / 2 }, armed === null && styles.notchBodyChipsOnly]}>
                  {armed !== null && (
                    <>
                      <Pressable
                        onPress={() => {
                          tapHaptic();
                          setSettingsFor(session.id);
                        }}
                        style={({ pressed }) => [styles.notchLabel, pressed && { opacity: 0.7 }]}
                      >
                        <SymbolView name="mic" size={12} tintColor={colors.accent} />
                        <Text variant="label" color="text" numberOfLines={1}>
                          {armed}
                        </Text>
                      </Pressable>
                      <Pressable
                        hitSlop={8}
                        onPress={() => {
                          tapHaptic();
                          dictationActor.send({ type: "arm", skill: null });
                        }}
                        style={({ pressed }) => [styles.notchClose, pressed && { opacity: 0.7 }]}
                      >
                        <SymbolView name="xmark" size={11} tintColor={colors.textMuted} />
                      </Pressable>
                    </>
                  )}
                  {images.map((image, index) => (
                    <Pressable
                      // Chips are identified by position: a detach shifts the ones after it, which is what the user sees.
                      key={index}
                      hitSlop={6}
                      onPress={() => {
                        tapHaptic();
                        dictationActor.send({ type: "detach", index });
                      }}
                      style={({ pressed }) => [styles.chip, pressed && { opacity: 0.7 }]}
                    >
                      <Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={styles.chipImage} />
                    </Pressable>
                  ))}
                  {images.length > 0 && (
                    <Pressable
                      hitSlop={8}
                      onPress={() => {
                        tapHaptic();
                        dictationActor.send({ type: "sendAttachments" });
                      }}
                      style={({ pressed }) => [styles.notchClose, pressed && { opacity: 0.7 }]}
                    >
                      <SymbolView name="paperplane" size={11} tintColor={colors.accent} />
                    </Pressable>
                  )}
                </View>
              </Cutout>
            )}
          </Animated.View>
        )}
        <ListeningOrb />
        {skills !== undefined && skills.length > 0 && (
          <View pointerEvents="none" style={styles.wheel}>
            <SkillWheel skills={skills} />
          </View>
        )}
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <ActionWheel entries={wheelEntries} visible={wheelVisible} center={wheelCenter} pointer={wheelPointer} onSelect={onWheelSelect} />
        </View>
      </View>
      {session !== undefined && (
        <View style={styles.panel}>
          {launchError !== null ? (
            <View style={styles.banner}>
              <Banner tone="danger" message={launchError} />
            </View>
          ) : canRespond ? (
            <Cutout size={MIC_SIZE} style={styles.mic}>
              <DictationButton size={MIC_SIZE} backgroundColor={colors.surface} {...(skills === undefined ? {} : { skills })} />
            </Cutout>
          ) : (
            <View style={styles.banner}>
              <Banner tone="warn" message="This session can't take replies." />
            </View>
          )}
          <View style={styles.scrubRow}>
            <View style={{ flex: 1 }}>
              <AgentScrubber statuses={order.map((id) => sessions[id]?.status ?? "ended")} index={index} onChange={onScrub} onLongPress={onHold} />
            </View>
            <IconButton symbol="plus" size={START_SIZE} tintColor={colors.textMuted} backgroundColor={colors.bg} disabled={!connected || launching} onPress={startSession} />
          </View>
          <Text variant="caption" color="textFaint" tabular style={styles.counter}>
            {launching ? "Starting a session…" : `${index + 1} of ${order.length}`}
          </Text>
        </View>
      )}
      <AgentSettingsSheet
        sessionId={settingsFor}
        onClose={() => {
          setSettingsFor(null);
        }}
      />
    </SafeAreaView>
  );
}

/**
 * Pill width for the seam notch: the armed token (icon, text at the label size, close button; capped
 * for long tokens) and, after it, `chips` thumbnails with their send button. Mirrors `notchBody`'s
 * padding and gap so the pill hugs its content.
 */
function notchWidth(token: string | null, chips: number): number {
  const close = spacing.sm + 22;
  const text = token === null ? 0 : Math.min(180, token.length * 7.2);
  const armed = token === null ? 0 : spacing.md + 12 + spacing.xs + text + close;
  const attachments = chips === 0 ? 0 : chips * (CHIP_SIZE + spacing.sm) + close;
  // Without the token the chips start at the narrow padding; with it, the gap before the first chip.
  const lead = token === null ? spacing.xs - spacing.sm : 0;
  return Math.round(lead + armed + attachments + spacing.xs);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  stack: { flex: 1, marginHorizontal: spacing.md, marginTop: spacing.sm },
  card: {
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: "hidden",
  },
  header: { backgroundColor: colors.surfaceRaised },
  chat: { flex: 1, marginTop: spacing.sm, backgroundColor: colors.surface },
  notchBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    gap: spacing.sm,
  },
  notchBodyChipsOnly: { paddingLeft: spacing.xs },
  notchLabel: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  notchClose: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceRaised },
  chip: { width: CHIP_SIZE, height: CHIP_SIZE, borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.surfaceRaised },
  chipImage: { width: CHIP_SIZE, height: CHIP_SIZE },
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
  /** Dial centered on the mic: the mic's center sits half the card gap below the card's bottom edge. */
  wheel: {
    position: "absolute",
    alignSelf: "center",
    bottom: -(spacing.sm / 2 + WHEEL_EXTENT),
  },
  banner: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    top: spacing.sm,
  },
  scrubRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  counter: { textAlign: "center", marginTop: spacing.md },
});
