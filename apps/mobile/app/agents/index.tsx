import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { SymbolView } from "expo-symbols";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type EntryExitAnimationFunction,
} from "react-native-reanimated";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { EmptyState } from "@/ui/EmptyState";
import { Cutout, CUTOUT_GAP } from "@/ui/Cutout";
import { NotchedSurface, type Notch } from "@/ui/NotchedSurface";
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
import { TypedReply } from "@/agents/TypedReply";
import { type ActionWheelEntry } from "@/agents/ActionWheel";
import { useActionWheel } from "@/agents/useActionWheel";
import { tapHaptic } from "@/lib/haptics";
import { copyText, readClipboardImage, readClipboardText } from "@/lib/clipboard";
import { warn } from "@/connection/log";

const MIC_SIZE = 60;
const CARD_RADIUS = 28;
/** The armed-skill notch on the seam between the header and the chat. */
const NOTCH_HEIGHT = 32;
/** The bites the surfaces take: the element plus the ring of screen background around it. */
const PILL_NOTCH_HEIGHT = NOTCH_HEIGHT + CUTOUT_GAP * 2;
const MIC_NOTCH_SIZE = MIC_SIZE + CUTOUT_GAP * 2;
/** The keyboard button on the seam, right of the mic, sharing its cutout treatment. */
const KEY_SIZE = 44;
const KEY_NOTCH_SIZE = KEY_SIZE + CUTOUT_GAP * 2;
/** Keyboard button center measured from the surface's middle: past the mic's ring, a sliver of background, then its own ring. */
const KEY_OFFSET = MIC_SIZE / 2 + CUTOUT_GAP + spacing.xs + CUTOUT_GAP + KEY_SIZE / 2;
/** The image pill's thumbnail, standing where the skill pill has its mic glyph. */
const CHIP_SIZE = 20;

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

const slideIn =
  (direction: number): EntryExitAnimationFunction =>
  () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateX: SLIDE_PX * direction }] },
      animations: {
        opacity: withTiming(1, { duration: motion.duration.base }),
        transform: [{ translateX: withTiming(0, { duration: motion.duration.base }) }],
      },
    };
  };

const slideOut =
  (direction: number): EntryExitAnimationFunction =>
  () => {
    "worklet";
    return {
      initialValues: { opacity: 1, transform: [{ translateX: 0 }] },
      animations: {
        opacity: withTiming(0, { duration: motion.duration.fast }),
        transform: [
          { translateX: withTiming(-SLIDE_PX * direction, { duration: motion.duration.fast }) },
        ],
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
  // A tapped notification arrives as `?sessionId=`; it wins until the user scrubs elsewhere.
  const { sessionId: linkedId } = useLocalSearchParams<{ sessionId?: string }>();
  const [pickedId, setPickedId] = useState<string | null>(linkedId ?? null);
  useEffect(() => {
    if (linkedId !== undefined) setPickedId(linkedId);
  }, [linkedId]);
  const selectedId = pickedId !== null && pickedId in sessions ? pickedId : order[0];
  const index = selectedId === undefined ? -1 : order.indexOf(selectedId);
  const lastIndex = useRef(index);
  const direction = index >= lastIndex.current ? 1 : -1;
  lastIndex.current = index;
  // The store orders manual sessions ahead of job runs; the boundary is where the jobs section starts.
  const jobsFrom = order.findIndex((id) => sessions[id]?.kind === "job");
  const manualCount = jobsFrom === -1 ? order.length : jobsFrom;

  const session = selectedId === undefined ? undefined : sessions[selectedId];
  const messages = selectedId === undefined ? undefined : conversations[selectedId]?.messages;
  // Without the wheel the button gets no skills, so the swipe left does nothing.
  const wheelEnabled = useSettingsStore((state) => state.skillWheelEnabled);
  const skills = useAgentsStore((state) =>
    !wheelEnabled || selectedId === undefined ? undefined : state.options[selectedId]?.skills,
  );

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

  const onScrub = useCallback((next: number) => {
    const id = useAgentsStore.getState().order[next];
    if (id !== undefined) setPickedId(id);
  }, []);

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

  // Typing instead of speaking: the header folds away so the chat keeps its room above the
  // keyboard, the seam loses the mic and keyboard button, and the panel becomes the field. The
  // draft outlives the mode; only a send clears it.
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (!canRespond) setTyping(false);
  }, [canRespond]);
  // Swiping the keyboard away is leaving typing mode, same as the mic button.
  useEffect(() => {
    if (!typing) return;
    const hide = Keyboard.addListener("keyboardWillHide", () => {
      setTyping(false);
    });
    return () => {
      hide.remove();
    };
  }, [typing]);
  const collapse = useSharedValue(0);
  useEffect(() => {
    collapse.value = withTiming(typing ? 1 : 0, { duration: motion.duration.base });
  }, [typing, collapse]);
  const sendTyped = (): void => {
    dictationActor.send({ type: "typed", text: draft });
    setDraft("");
  };
  const leaveTyping = (): void => {
    setTyping(false);
    Keyboard.dismiss();
  };

  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const onHold = useCallback((slot: number) => {
    const id = useAgentsStore.getState().order[slot];
    if (id !== undefined) setSettingsFor(id);
  }, []);

  const { skill: armed, images, pasted, phase } = useDictation();
  const [headerHeight, setHeaderHeight] = useState(0);
  const [chatHeight, setChatHeight] = useState(0);
  const [chatWidth, setChatWidth] = useState(0);
  // The header slides up by its own height and the chat grows into the gap; the seam pill rides
  // along so it stays on the chat's top edge.
  const headerStyle = useAnimatedStyle(() => ({
    marginTop: -headerHeight * collapse.value,
    opacity: 1 - collapse.value,
  }));
  const pillStyle = useAnimatedStyle(() => ({
    top: headerHeight * (1 - collapse.value) + spacing.sm / 2 - NOTCH_HEIGHT / 2 - CUTOUT_GAP,
  }));

  // Holding still on the chat opens the action wheel under the finger; the wheel draws in the
  // stack's coordinates, so the chat card's offset (below the header) is mirrored for the worklets.
  const chatTop = useSharedValue(0);
  useAnimatedReaction(
    () => headerHeight * (1 - collapse.value) + spacing.sm,
    (top) => {
      chatTop.value = top;
    },
  );
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
    // Paste: an image or text attaches to the next send.
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
      dictationActor.send({ type: "attachText", text });
    })().catch((error: unknown) => {
      warn("agents", "paste failed", error);
    });
  }, []);
  const { gesture: chatGesture, wheel } = useActionWheel({
    entries: wheelEntries,
    onSelect: onWheelSelect,
    offsetY: chatTop,
  });

  const notchShown = (armed !== null || images.length > 0 || pasted !== null) && headerHeight > 0;
  // The seam pill, the mic and the keyboard button bite into the surfaces they straddle; `cy` is in
  // each surface's own coordinates (the pill center sits half the card gap below the header, the
  // mic and keyboard half the gap below the chat card). The Cutout overlays still paint the gap
  // ring over scrolled content. While typing the seam is empty and the panel is unbroken.
  const pillWidth = notchShown ? notchWidth(armed, images.length, pasted) + CUTOUT_GAP * 2 : 0;
  const seamShown = canRespond && !typing;
  const headerNotches = useMemo<Notch[]>(
    () =>
      pillWidth === 0
        ? []
        : [{ cy: headerHeight + spacing.sm / 2, width: pillWidth, height: PILL_NOTCH_HEIGHT }],
    [pillWidth, headerHeight],
  );
  const seamNotches = useCallback(
    (cy: number): Notch[] => [
      { cy, width: MIC_NOTCH_SIZE, height: MIC_NOTCH_SIZE },
      { cx: chatWidth / 2 + KEY_OFFSET, cy, width: KEY_NOTCH_SIZE, height: KEY_NOTCH_SIZE },
    ],
    [chatWidth],
  );
  const chatNotches = useMemo<Notch[]>(() => {
    const notches: Notch[] =
      pillWidth === 0 ? [] : [{ cy: -spacing.sm / 2, width: pillWidth, height: PILL_NOTCH_HEIGHT }];
    if (seamShown) notches.push(...seamNotches(chatHeight + spacing.sm / 2));
    return notches;
  }, [pillWidth, seamShown, seamNotches, chatHeight]);
  const panelNotches = useMemo<Notch[]>(
    () => (seamShown ? seamNotches(-spacing.sm / 2) : []),
    [seamShown, seamNotches],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <View style={styles.stack}>
          {session === undefined ? (
            <View style={[styles.card, styles.chat]}>
              <EmptyState
                symbol="tray"
                title="No agent sessions"
                body={
                  connected
                    ? "Start one here, or open omp on your host."
                    : "Sessions show up here while omp is running on your host."
                }
                {...(connected && !launching
                  ? { actionLabel: "Start a session", onAction: startSession }
                  : {})}
              />
            </View>
          ) : (
            <Animated.View
              key={session.id}
              style={StyleSheet.absoluteFill}
              entering={slideIn(direction)}
              exiting={slideOut(direction)}
            >
              <Animated.View style={headerStyle}>
                <NotchedSurface
                  color={colors.surfaceRaised}
                  radius={CARD_RADIUS}
                  notches={headerNotches}
                  onLayout={(event) => {
                    setHeaderHeight(event.nativeEvent.layout.height);
                  }}
                >
                  <AgentHeader session={session} />
                </NotchedSurface>
              </Animated.View>
              <GestureDetector gesture={chatGesture}>
                <NotchedSurface
                  color={colors.surface}
                  radius={CARD_RADIUS}
                  notches={chatNotches}
                  style={styles.chat}
                  onLayout={(event) => {
                    setChatHeight(event.nativeEvent.layout.height);
                    setChatWidth(event.nativeEvent.layout.width);
                  }}
                >
                  <AgentCard sessionId={selectedId} messages={messages} connected={connected} status={session.status} activity={session.statusDetail} />
                </NotchedSurface>
              </GestureDetector>
              {notchShown && (
                <Animated.View pointerEvents="box-none" style={[styles.pillLane, pillStyle]}>
                  <Cutout
                    size={NOTCH_HEIGHT}
                    width={notchWidth(armed, images.length, pasted)}
                    style={{ alignSelf: "center" }}
                  >
                    <View style={styles.notchBody}>
                      {armed !== null && (
                        <>
                          <Pressable
                            onPress={() => {
                              tapHaptic();
                              setSettingsFor(session.id);
                            }}
                            style={({ pressed }) => [
                              styles.notchLabel,
                              pressed && { opacity: 0.7 },
                            ]}
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
                            style={({ pressed }) => [
                              styles.notchClose,
                              pressed && { opacity: 0.7 },
                            ]}
                          >
                            <SymbolView name="xmark" size={11} tintColor={colors.textMuted} />
                          </Pressable>
                        </>
                      )}
                      {images[0] !== undefined && (
                        <>
                          <Pressable
                            onPress={() => {
                              tapHaptic();
                              dictationActor.send({ type: "sendAttachments" });
                            }}
                            style={({ pressed }) => [
                              styles.notchLabel,
                              pressed && { opacity: 0.7 },
                            ]}
                          >
                            <Image
                              source={{
                                uri: `data:${images[0].mimeType};base64,${images[0].data}`,
                              }}
                              style={styles.chip}
                            />
                            <Text variant="label" color="text" numberOfLines={1}>
                              {images.length === 1 ? "Image" : `${String(images.length)} images`}
                            </Text>
                            <SymbolView name="arrow.up" size={11} tintColor={colors.accent} />
                          </Pressable>
                          <Pressable
                            hitSlop={8}
                            onPress={() => {
                              tapHaptic();
                              dictationActor.send({ type: "detach", index: images.length - 1 });
                            }}
                            style={({ pressed }) => [
                              styles.notchClose,
                              pressed && { opacity: 0.7 },
                            ]}
                          >
                            <SymbolView name="xmark" size={11} tintColor={colors.textMuted} />
                          </Pressable>
                        </>
                      )}
                      {pasted !== null && (
                        <>
                          <Pressable
                            onPress={() => {
                              tapHaptic();
                              dictationActor.send({ type: "sendAttachments" });
                            }}
                            style={({ pressed }) => [
                              styles.notchLabel,
                              pressed && { opacity: 0.7 },
                            ]}
                          >
                            <SymbolView name="text.quote" size={12} tintColor={colors.accent} />
                            <Text variant="label" color="text" numberOfLines={1}>
                              {pastedLabel(pasted)}
                            </Text>
                            <SymbolView name="arrow.up" size={11} tintColor={colors.accent} />
                          </Pressable>
                          <Pressable
                            hitSlop={8}
                            onPress={() => {
                              tapHaptic();
                              dictationActor.send({ type: "attachText", text: null });
                            }}
                            style={({ pressed }) => [
                              styles.notchClose,
                              pressed && { opacity: 0.7 },
                            ]}
                          >
                            <SymbolView name="xmark" size={11} tintColor={colors.textMuted} />
                          </Pressable>
                        </>
                      )}
                    </View>
                  </Cutout>
                </Animated.View>
              )}
            </Animated.View>
          )}
          <ListeningOrb />
          {skills !== undefined && skills.length > 0 && (
            <View pointerEvents="none" style={styles.wheel}>
              <SkillWheel skills={skills} />
            </View>
          )}
          {wheel}
        </View>
        {session !== undefined && typing && (
          <NotchedSurface
            color={colors.surfaceRaised}
            radius={CARD_RADIUS}
            notches={panelNotches}
            style={styles.panelTyping}
          >
            <TypedReply
              draft={draft}
              onDraft={setDraft}
              canSend={phase === "idle"}
              onSend={sendTyped}
              onVoice={leaveTyping}
            />
          </NotchedSurface>
        )}
        {session !== undefined && !typing && (
          <NotchedSurface
            color={colors.surfaceRaised}
            radius={CARD_RADIUS}
            notches={panelNotches}
            style={styles.panel}
            overlay={
              launchError !== null ? (
                <View style={styles.banner}>
                  <Banner tone="danger" message={launchError} />
                </View>
              ) : canRespond ? (
                <>
                  <Cutout size={MIC_SIZE} style={styles.mic}>
                    <DictationButton
                      size={MIC_SIZE}
                      backgroundColor={colors.surface}
                      {...(skills === undefined ? {} : { skills })}
                      {...(connected && !launching ? { onLift: startSession } : {})}
                    />
                  </Cutout>
                  {/* Ring centered on the seam like the mic; `left` from the measured width, a percentage would resolve against the padded box. */}
                  <Cutout
                    size={KEY_SIZE}
                    style={{
                      top: -(KEY_SIZE / 2 + CUTOUT_GAP + spacing.sm / 2),
                      left: chatWidth / 2 + KEY_OFFSET - KEY_NOTCH_SIZE / 2,
                    }}
                  >
                    <IconButton
                      symbol="keyboard"
                      size={KEY_SIZE}
                      tintColor={colors.textMuted}
                      backgroundColor={colors.surface}
                      onPress={() => {
                        setTyping(true);
                      }}
                    />
                  </Cutout>
                </>
              ) : (
                <View style={styles.banner}>
                  <Banner tone="warn" message="This session can't take replies." />
                </View>
              )
            }
          >
            <View style={styles.scrubRow}>
              <View style={{ flex: 1 }}>
                <AgentScrubber
                  statuses={order.map((id) => sessions[id]?.status ?? "ended")}
                  index={index}
                  {...(jobsFrom > 0 ? { divider: jobsFrom } : {})}
                  onChange={onScrub}
                  onLongPress={onHold}
                />
              </View>
              <IconButton
                symbol="plus"
                size={START_SIZE}
                tintColor={colors.textMuted}
                backgroundColor={colors.bg}
                disabled={!connected || launching}
                onPress={startSession}
              />
            </View>
            <Text variant="caption" color="textFaint" tabular style={styles.counter}>
              {launching
                ? "Starting a session…"
                : jobsFrom !== -1 && index >= jobsFrom
                  ? `Jobs · ${index - jobsFrom + 1} of ${order.length - jobsFrom}`
                  : `${index + 1} of ${manualCount}`}
            </Text>
          </NotchedSurface>
        )}
      </KeyboardAvoidingView>
      <AgentSettingsSheet
        sessionId={settingsFor}
        onClose={() => {
          setSettingsFor(null);
        }}
      />
    </SafeAreaView>
  );
}

/** The pasted text's first words, enough to recognise it, never long enough to crowd the pill. */
function pastedLabel(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 18 ? `${line.slice(0, 17)}…` : line;
}

/**
 * Pill width for the seam notch: the armed token (mic, text at the label size, close button; capped
 * for long tokens), the image segment (thumbnail, "Image" or "N images", arrow, close) and the
 * pasted-text segment (quote glyph, first words, arrow, close). Mirrors `notchBody`'s padding
 * and gap so the pill hugs its content.
 */
function notchWidth(token: string | null, chips: number, pasted: string | null): number {
  const close = spacing.sm + 22;
  const segments: number[] = [];
  if (token !== null) segments.push(12 + spacing.xs + Math.min(180, token.length * 7.2) + close);
  if (chips > 0)
    segments.push(
      CHIP_SIZE +
        spacing.xs +
        (chips === 1 ? "Image" : `${String(chips)} images`).length * 7.2 +
        spacing.xs +
        11 +
        close,
    );
  if (pasted !== null)
    segments.push(12 + spacing.xs + pastedLabel(pasted).length * 7.2 + spacing.xs + 11 + close);
  const content =
    segments.reduce((sum, width) => sum + width, 0) + Math.max(0, segments.length - 1) * spacing.sm;
  return Math.round(spacing.md + content + spacing.xs);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  stack: { flex: 1, marginHorizontal: spacing.md, marginTop: spacing.sm },
  /** The empty state's card, which nothing bites into. */
  card: {
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  chat: { flex: 1, marginTop: spacing.sm },
  /** Full-width lane the seam pill is centered in; its `top` follows the header as it folds. */
  pillLane: { position: "absolute", left: 0, right: 0 },
  notchBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: NOTCH_HEIGHT / 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    gap: spacing.sm,
  },
  notchLabel: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  notchClose: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
  },
  chip: {
    width: CHIP_SIZE,
    height: CHIP_SIZE,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceRaised,
  },
  panel: {
    height: PANEL_HEIGHT,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    paddingTop: PANEL_TOP,
    paddingHorizontal: spacing.lg,
  },
  /** The field panel: sized by its content, no seam bite above it. */
  panelTyping: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    padding: spacing.md,
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
