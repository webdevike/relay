/**
 * Eva, the personal assistant: one durable conversation the host keeps for Isaac, separate from
 * the Agent Inbox. The host owns the thread (`useAssistantStore` mirrors its snapshot while this
 * screen is showing); this screen renders it as a chat, sends a turn with `assistant.turn`, and
 * echoes the sent words until the host's next snapshot carries them.
 *
 * Look (after OpenAI's Dots chat): no title; the agent's avatar ring and name chip float at the
 * top centre over a list that blurs and fades beneath them (tapping them opens a menu); the user's
 * words are blue bubbles on the right with a delivery receipt, Eva's replies are dark grey bubbles
 * on the left with a typing bubble while she works; the composer is a floating pill the list
 * scrolls under, which grows into a card once there is text.
 */
import { useCallback, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";
import { useFocusEffect, useRouter } from "expo-router";
import type { AssistantMessage } from "@relay/protocol";
import { AvatarRing } from "@/ui/AvatarRing";
import { Banner } from "@/ui/Banner";
import { Callout } from "@/ui/Callout";
import { EdgeFade } from "@/ui/EdgeFade";
import { EmptyState } from "@/ui/EmptyState";
import { ExpandableContent } from "@/ui/ExpandableContent";
import { FloatingPill, FloatingPillInput, PILL_HEIGHT } from "@/ui/FloatingPill";
import { IconButton } from "@/ui/IconButton";
import { Row as MenuRow } from "@/ui/Row";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { TopBlur } from "@/ui/TopBlur";
import { TypingBubble } from "@/ui/TypingBubble";
import { MessageText } from "@/agents/MessageText";
import { radii, spacing, useColors, useScheme } from "@/theme";
import { useAssistantStore } from "@/state/assistant";
import { useConnectionStore } from "@/state/connection";
import { requestAssistant, sendCommand, stopAssistant } from "@/connection";
import { notifyHaptic } from "@/lib/haptics";

/** Within this many points of the newest message, a new one keeps the list pinned to it. */
const BOTTOM_STICK_PX = 80;
/** Id of the row echoing a sent turn before the host's snapshot lists it. */
const PENDING_ID = "pending-turn";
/** Name on the chip under the avatar ring. */
const AGENT_NAME = "Eva";
/** Space below the status bar that the avatar ring and its chip take (4 gap, 72 ring, 6, 28 chip). */
const HEADER_HEIGHT = 112;
/** The oldest rows start this far below the header, so they open clear of the avatar. */
const HEADER_GAP = 8;
/** How far below the status bar the blur and fade reach. */
const FADE_BELOW_INSET = 100;
/** Gap between the pill and the bottom safe area. */
const COMPOSER_BOTTOM = spacing.md;
/** An assistant bubble shows about 12 lines of 17/22 text before "Show more". */
const BUBBLE_MAX_HEIGHT = 22 * 12;
/** Proportion of the width a bubble may take. */
const USER_MAX_WIDTH = "75%";
const EVA_MAX_WIDTH = "90%";

export default function Eva() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const snapshot = useAssistantStore((state) => state.snapshot);
  const pending = useAssistantStore((state) => state.pending);
  const setPending = useAssistantStore((state) => state.setPending);
  const connected = useConnectionStore((state) => state.status === "connected");
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  // True once the host acked the sent turn, while the snapshot may not list it yet.
  const [delivered, setDelivered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The composer floats over the list, so the list pads itself by however tall the composer is.
  const [composerHeight, setComposerHeight] = useState(PILL_HEIGHT + COMPOSER_BOTTOM);

  // The thread is fetched only while this screen shows; the driver re-asks on every welcome in between.
  useFocusEffect(
    useCallback(() => {
      requestAssistant();
      return () => {
        stopAssistant();
      };
    }, []),
  );

  const text = draft.trim();
  const canSend = connected && text !== "";

  const send = (): void => {
    if (!canSend) return;
    setFailure(null);
    setDelivered(false);
    setPending(text);
    setDraft("");
    sendCommand({ kind: "assistant.turn", text }).then(
      () => {
        setDelivered(true);
      },
      (error: unknown) => {
        notifyHaptic("error");
        // The words come back to the field, so a lost connection never eats a message.
        setPending(null);
        setDraft((current) => (current === "" ? text : current));
        setFailure(error instanceof Error && error.message !== "" ? error.message : "Couldn't reach Eva.");
      },
    );
  };

  const messages = snapshot?.messages ?? [];
  const rows: AssistantMessage[] =
    pending === null ? messages : [...messages, { id: PENDING_ID, role: "user", text: pending.text, at: Date.now() }];
  const newestFirst = [...rows].reverse();
  const busy = snapshot?.busy === true;

  // Only the newest user message carries a receipt: Sending, Delivered (acked, not in the snapshot
  // yet), then Seen once the host's snapshot lists it.
  const latestUserId = newestFirst.find((message) => message.role === "user")?.id ?? null;
  const receipt = latestUserId === null ? null : latestUserId === PENDING_ID ? (delivered ? "Delivered" : "Sending") : "Seen";

  const topZone = insets.top + FADE_BELOW_INSET;
  const listTop = insets.top + HEADER_HEIGHT + HEADER_GAP;

  const onComposerLayout = (event: LayoutChangeEvent): void => {
    setComposerHeight(event.nativeEvent.layout.height);
  };

  const go = (path: "/screen" | "/agents"): void => {
    setMenuOpen(false);
    router.push(path);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={["bottom"]}>
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <View style={styles.fill}>
          {rows.length === 0 ? (
            <View style={[styles.fill, { paddingTop: listTop, paddingBottom: composerHeight }]}>
              <EmptyState
                symbol="bubble.left.and.text.bubble.right"
                title="Say hi to Eva"
                body={connected || snapshot !== null ? "She lives on your Mac and keeps this one conversation going, day and night." : "Connect to your host to load the conversation."}
              />
            </View>
          ) : (
            <FlatList
              style={styles.fill}
              data={newestFirst}
              inverted
              keyExtractor={(message) => message.id}
              extraData={`${latestUserId ?? ""}|${receipt ?? ""}`}
              renderItem={({ item }) => (
                <Row message={item} pending={item.id === PENDING_ID} receipt={item.id === latestUserId ? receipt : null} />
              )}
              // Inverted: the header sits at the visual bottom, below the newest row.
              ListHeaderComponent={busy ? <TypingRow /> : null}
              // Inverted: the top padding is the visual bottom (above the composer), the bottom
              // padding the visual top (below the avatar).
              contentContainerStyle={[styles.list, { paddingTop: composerHeight + spacing.md, paddingBottom: listTop }]}
              maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: BOTTOM_STICK_PX }}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
            />
          )}
          <TopBlur height={topZone} />
          <EdgeFade color={colors.bg} height={topZone} strength={0.6} solid={0} />
          <View pointerEvents="box-none" style={[styles.header, { top: insets.top + spacing.xs }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${AGENT_NAME} menu`}
              onPress={() => {
                setMenuOpen(true);
              }}
            >
              <AvatarRing name={AGENT_NAME} breathing={busy} />
            </Pressable>
            <View style={styles.back}>
              <BackButton
                onPress={() => {
                  router.back();
                }}
              />
            </View>
          </View>
        </View>
        {/* Pulled over the list by its own height, so the list runs under it. */}
        <View onLayout={onComposerLayout} style={[styles.composer, { marginTop: -composerHeight }]}>
          {failure !== null && (
            <View style={[styles.banner, { backgroundColor: colors.bg }]}>
              <Banner tone="danger" message={failure} />
            </View>
          )}
          <View style={styles.pillRow}>
            <FloatingPill
              expanded={text !== ""}
              leading={<AttachButton />}
              trailing={text === "" ? <DictateButton /> : <SendButton onPress={send} disabled={!canSend} />}
            >
              <FloatingPillInput
                value={draft}
                onChangeText={setDraft}
                placeholder={connected ? "Message" : "Not connected"}
                editable={connected}
                tall={text !== ""}
                accessibilityLabel="Message Eva"
              />
            </FloatingPill>
          </View>
        </View>
      </KeyboardAvoidingView>
      <Sheet
        visible={menuOpen}
        onClose={() => {
          setMenuOpen(false);
        }}
      >
        <Text variant="title" style={styles.menuTitle}>
          {AGENT_NAME}
        </Text>
        <View style={styles.menuRows}>
          <MenuRow
            title={`${AGENT_NAME}'s computer`}
            leading={<SymbolView name="laptopcomputer" size={20} tintColor={colors.textMuted} />}
            onPress={() => {
              go("/screen");
            }}
          />
          <MenuRow
            title="Agent Inbox"
            leading={<SymbolView name="tray" size={20} tintColor={colors.textMuted} />}
            onPress={() => {
              go("/agents");
            }}
          />
        </View>
      </Sheet>
    </SafeAreaView>
  );
}

/** Round glass back chevron: translucent white on dark, the surface colour on light. */
function BackButton({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  return dark ? (
    <IconButton symbol="chevron.left" onPress={onPress} tone="overlay" accessibilityLabel="Back" />
  ) : (
    <IconButton symbol="chevron.left" onPress={onPress} backgroundColor={colors.surface} tintColor={colors.text} accessibilityLabel="Back" />
  );
}

/** "+" at the pill's left. Attachments are not wired yet, so it shows dimmed and inert. */
function AttachButton() {
  const colors = useColors();
  const dark = useScheme() === "dark";
  return (
    <IconButton
      symbol="plus"
      size={28}
      glyphSize={15}
      onPress={noop}
      disabled
      disabledOpacity={0.5}
      backgroundColor={dark ? "rgba(255,255,255,0.12)" : colors.surfaceRaised}
      accessibilityLabel="Attach, coming soon"
    />
  );
}

/** Mic at the pill's right while the field is empty. Dictation is not wired here yet. */
function DictateButton() {
  return (
    <IconButton
      symbol="mic"
      size={32}
      glyphSize={19}
      onPress={noop}
      disabled
      disabledOpacity={0.5}
      backgroundColor="transparent"
      accessibilityLabel="Dictate, coming soon"
    />
  );
}

/** Filled round arrow that replaces the mic once there is text: user-bubble blue with a white arrow. */
function SendButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const colors = useColors();
  return (
    <IconButton
      symbol="arrow.up"
      size={32}
      glyphSize={16}
      onPress={onPress}
      disabled={disabled}
      backgroundColor={colors.bubbleUser}
      tintColor="#FFFFFF"
      accessibilityLabel="Send"
    />
  );
}

/** The attach and dictate buttons are disabled; this only satisfies the required `onPress`. */
const noop = (): undefined => undefined;

/** The typing bubble, as the newest row while Eva is working. */
function TypingRow() {
  return (
    <View style={styles.evaRow}>
      <TypingBubble />
    </View>
  );
}

function Row({ message, pending, receipt }: { message: AssistantMessage; pending: boolean; receipt: string | null }) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  switch (message.role) {
    case "user":
      return (
        <View style={styles.userRow}>
          <View style={[styles.userBubble, { backgroundColor: colors.bubbleUser, opacity: pending ? 0.6 : 1 }]}>
            <Text style={styles.userText}>{message.text}</Text>
          </View>
          {receipt !== null && (
            <Text variant="label" color="textMuted" style={styles.receipt}>
              {receipt}
            </Text>
          )}
        </View>
      );
    case "assistant":
      return (
        <View style={styles.evaRow}>
          <View style={[styles.evaBubble, { backgroundColor: dark ? colors.surfaceRaised : colors.surface }]}>
            <ExpandableContent maxHeight={BUBBLE_MAX_HEIGHT}>
              <MessageText text={message.text} large />
            </ExpandableContent>
          </View>
        </View>
      );
    case "status":
      return (
        <Text variant="label" color="textMuted" style={styles.status}>
          {message.text}
        </Text>
      );
    case "card":
      return (
        <View style={styles.evaRow}>
          <View style={[styles.card, { borderColor: colors.hairline }]}>
            {message.title !== undefined && message.title !== "" && <Text variant="label">{message.title}</Text>}
            <MessageText text={message.text} />
          </View>
        </View>
      );
    case "error":
      return (
        <View style={styles.evaRow}>
          <Callout tone="danger" title={message.title} text={message.text} />
        </View>
      );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  list: { gap: spacing.lg },
  header: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  back: { position: "absolute", top: spacing.xs, left: spacing.lg },
  userRow: { paddingHorizontal: spacing.lg, alignItems: "flex-end" },
  userBubble: { maxWidth: USER_MAX_WIDTH, borderRadius: 22, paddingVertical: 14, paddingHorizontal: 18 },
  userText: { fontSize: 17, lineHeight: 22, color: "#FFFFFF" },
  receipt: { marginTop: spacing.xs, fontWeight: "400" },
  evaRow: { paddingHorizontal: spacing.lg },
  evaBubble: { alignSelf: "flex-start", maxWidth: EVA_MAX_WIDTH, borderRadius: 22, padding: 18 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  status: { textAlign: "center", paddingHorizontal: spacing.xxxl, fontWeight: "400" },
  composer: { paddingBottom: COMPOSER_BOTTOM },
  banner: { paddingBottom: spacing.sm },
  pillRow: { paddingHorizontal: spacing.lg },
  menuTitle: { textAlign: "center", paddingBottom: spacing.md },
  menuRows: { marginHorizontal: -spacing.xl },
});
