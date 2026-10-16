/**
 * Eva, the personal assistant: one durable conversation the host keeps for Isaac, separate from
 * the Agent Inbox. The host owns the thread (`useAssistantStore` mirrors its snapshot while this
 * screen is showing); this screen renders it as a chat, sends a turn with `assistant.turn`, and
 * echoes the sent words and pictures until the host's next snapshot carries them. The pill's "+"
 * opens a sheet to pick library photos or paste a clipboard image; queued images show as
 * thumbnails above the field. Bubbles stack their images above the text, tap to open.
 *
 * Look (after OpenAI's Dots chat): no title; the agent's avatar ring and name chip float at the
 * top centre over a list that blurs and fades beneath them (tapping them opens a menu); the user's
 * words are blue bubbles on the right with a delivery receipt, Eva's replies are dark grey bubbles
 * on the left with a typing bubble while she works; the composer is a floating pill the list
 * scrolls under, which grows into a card once there is text.
 */
import { useCallback, useMemo, useState } from "react";
import { ActionSheetIOS, FlatList, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { MAX_REPLY_IMAGES, type AssistantMessage } from "@relay/protocol";
import { AttachmentTray } from "@/ui/AttachmentTray";
import { AvatarRing } from "@/ui/AvatarRing";
import { Banner } from "@/ui/Banner";
import { Callout } from "@/ui/Callout";
import { EdgeFade } from "@/ui/EdgeFade";
import { EmptyState } from "@/ui/EmptyState";
import { ExpandableContent } from "@/ui/ExpandableContent";
import { FloatingPill, FloatingPillInput, PILL_HEIGHT } from "@/ui/FloatingPill";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { TopBlur } from "@/ui/TopBlur";
import { TypingBubble } from "@/ui/TypingBubble";
import { ImageViewer } from "@/agents/ImageViewer";
import { MessageImageStack } from "@/agents/MessageImageStack";
import { MessageText } from "@/agents/MessageText";
import { radii, spacing, useColors, useScheme } from "@/theme";
import { useAssistantStore } from "@/state/assistant";
import { useConnectionStore } from "@/state/connection";
import { requestAssistant, sendCommand, stopAssistant } from "@/connection";
import { notifyHaptic } from "@/lib/haptics";
import { clipboardHasImage, readClipboardPhoto } from "@/lib/clipboard";
import { chooseLibraryPhotos, type Photo } from "@/lib/photo";

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
const USER_MAX_WIDTH = "80%";
const EVA_MAX_WIDTH = "84%";

export default function Eva() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const snapshot = useAssistantStore((state) => state.snapshot);
  const pending = useAssistantStore((state) => state.pending);
  const setPending = useAssistantStore((state) => state.setPending);
  const connected = useConnectionStore((state) => state.status === "connected");
  const [draft, setDraft] = useState("");
  // The pill grows into a card only once the text needs a second line, as Dot's does.
  const [wrapped, setWrapped] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // True once the host acked the sent turn, while the snapshot may not list it yet.
  const [delivered, setDelivered] = useState(false);
  // The composer floats over the list, so the list pads itself by however tall the composer is.
  const [composerHeight, setComposerHeight] = useState(PILL_HEIGHT + COMPOSER_BOTTOM);
  // Images queued on the composer, sent with the next turn.
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The images of the tapped bubble, open in the full-screen viewer.
  const [viewing, setViewing] = useState<{ uris: string[]; start: number } | null>(null);
  const viewerImages = useMemo(() => (viewing === null ? null : viewing.uris.map((uri) => ({ uri }))), [viewing]);

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
  const canSend = connected && (text !== "" || photos.length > 0);
  const full = photos.length >= MAX_REPLY_IMAGES;

  const attach = (source: "library" | "clipboard"): void => {
    setFailure(null);
    const picked =
      source === "library"
        ? chooseLibraryPhotos(MAX_REPLY_IMAGES - photos.length)
        : readClipboardPhoto().then((photo) => (photo === null ? [] : [photo]));
    picked.then(
      (added) => {
        setPhotos((current) => [...current, ...added].slice(0, MAX_REPLY_IMAGES));
      },
      (error: unknown) => {
        setFailure(error instanceof Error && error.message !== "" ? error.message : "Couldn't attach the image.");
      },
    );
  };

  const send = (): void => {
    if (!canSend) return;
    const sent = photos;
    setFailure(null);
    setDelivered(false);
    setPending({ text, images: sent });
    setDraft("");
    setPhotos([]);
    sendCommand({ kind: "assistant.turn", text, ...(sent.length > 0 ? { images: sent.map((photo) => photo.image) } : {}) }).then(
      () => {
        setDelivered(true);
      },
      (error: unknown) => {
        notifyHaptic("error");
        // The words and pictures come back to the composer, so a lost connection never eats a message.
        setPending(null);
        setDraft((current) => (current === "" ? text : current));
        setPhotos((current) => (current.length === 0 ? sent : current));
        setFailure(error instanceof Error && error.message !== "" ? error.message : "Couldn't reach Eva.");
      },
    );
  };

  // Image bytes are fetched against the omp session the thread runs in; empty while Eva is not running.
  const sessionId = snapshot === null || snapshot.sessionId === "" ? null : snapshot.sessionId;

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

  /** The avatar menu: a native action sheet, since a bottom-sheet modal did not present on this screen. */
  const openMenu = (): void => {
    Keyboard.dismiss();
    ActionSheetIOS.showActionSheetWithOptions(
      { title: AGENT_NAME, options: [`${AGENT_NAME}'s computer`, "Agent Inbox", "Cancel"], cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) router.push("/screen");
        if (index === 1) router.push("/agents");
      },
    );
  };

  /** The attach menu, native too; the paste row is disabled when the clipboard holds no image. */
  const openAttach = (): void => {
    Keyboard.dismiss();
    clipboardHasImage().then(
      (has) => {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: full ? `Up to ${String(MAX_REPLY_IMAGES)} images` : "Attach",
            options: ["Photo library", has ? "Paste image" : "Paste image (none on the clipboard)", "Cancel"],
            cancelButtonIndex: 2,
            disabledButtonIndices: full ? [0, 1] : has ? [] : [1],
          },
          (index) => {
            if (index === 0) attach("library");
            if (index === 1) attach("clipboard");
          },
        );
      },
      () => {
        setFailure("Couldn't read the clipboard.");
      },
    );
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
                <Row
                  message={item}
                  pending={item.id === PENDING_ID}
                  receipt={item.id === latestUserId ? receipt : null}
                  sessionId={sessionId}
                  local={item.id === PENDING_ID ? pending?.images : undefined}
                  onOpenImages={(uris, start) => {
                    setViewing({ uris, start });
                  }}
                />
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
              onPress={openMenu}
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
              expanded={photos.length > 0 || (wrapped && text !== "")}
              leading={
                <AttachButton
                  onPress={openAttach}
                  disabled={!connected}
                />
              }
              trailing={text === "" && photos.length === 0 ? <DictateButton /> : <SendButton onPress={send} disabled={!canSend} />}
            >
              {photos.length > 0 && (
                <View style={styles.tray}>
                  <AttachmentTray
                    uris={photos.map((photo) => photo.uri)}
                    onRemove={(index) => {
                      setPhotos((current) => current.filter((_, i) => i !== index));
                    }}
                  />
                </View>
              )}
              <FloatingPillInput
                value={draft}
                onChangeText={setDraft}
                onLines={(lines) => {
                  setWrapped(lines > 1);
                }}
                placeholder={connected ? "Message" : "Not connected"}
                editable={connected}
                tall={wrapped && text !== ""}
                accessibilityLabel="Message Eva"
              />
            </FloatingPill>
          </View>
        </View>
      </KeyboardAvoidingView>
      <ImageViewer
        images={viewerImages}
        start={viewing?.start ?? 0}
        onClose={() => {
          setViewing(null);
        }}
      />
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

/** "+" at the pill's left: opens the attach sheet. */
function AttachButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  return <IconButton symbol="plus" size={32} glyphSize={22} onPress={onPress} disabled={disabled} backgroundColor="transparent" accessibilityLabel="Attach image" />;
}

/** Mic at the pill's right while the field is empty. Dictation is not wired here yet. */
function DictateButton() {
  return (
    <IconButton
      symbol="mic"
      size={32}
      glyphSize={21}
      onPress={noop}
      disabled
      disabledOpacity={0.8}
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

/** The dictate button is disabled; this only satisfies the required `onPress`. */
const noop = (): undefined => undefined;

/** The typing bubble, as the newest row while Eva is working. */
function TypingRow() {
  return (
    <View style={styles.evaRow}>
      <TypingBubble />
    </View>
  );
}

interface RowProps {
  message: AssistantMessage;
  pending: boolean;
  receipt: string | null;
  /** The omp session the thread runs in, for fetching image bytes; null while Eva is not running. */
  sessionId: string | null;
  /** The echoed turn's images, still on the phone; shown instead of the message's host refs. */
  local: Photo[] | undefined;
  onOpenImages: (uris: string[], start: number) => void;
}

function Row({ message, pending, receipt, sessionId, local, onOpenImages }: RowProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const hasText = message.text !== "";
  const imageCount = local !== undefined ? local.length : (message.images?.length ?? 0);
  // Images stack above the text, left or right with the bubble.
  const images = (align: "flex-start" | "flex-end") =>
    imageCount === 0 ? null : (
      <View style={hasText ? styles.imagesAbove : undefined}>
        <MessageImageStack
          sessionId={sessionId}
          refs={message.images}
          local={local}
          align={align}
          opacity={pending ? 0.6 : 1}
          onOpen={onOpenImages}
        />
      </View>
    );
  switch (message.role) {
    case "user":
      return (
        <View style={styles.userRow}>
          {images("flex-end")}
          {(hasText || imageCount === 0) && (
            <View style={[styles.userBubble, { backgroundColor: colors.bubbleUser, opacity: pending ? 0.6 : 1 }]}>
              <Text style={styles.userText}>{message.text}</Text>
            </View>
          )}
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
          {images("flex-start")}
          {(hasText || imageCount === 0) && (
            <View style={[styles.evaBubble, { backgroundColor: dark ? colors.surfaceRaised : colors.surface }]}>
              <ExpandableContent maxHeight={BUBBLE_MAX_HEIGHT}>
                <MessageText text={message.text} large />
              </ExpandableContent>
            </View>
          )}
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
  list: { gap: spacing.xl },
  header: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  back: { position: "absolute", top: spacing.xs, left: spacing.lg },
  userRow: { paddingHorizontal: spacing.lg, alignItems: "flex-end" },
  userBubble: { maxWidth: USER_MAX_WIDTH, borderRadius: 24, paddingVertical: 11, paddingHorizontal: 18 },
  userText: { fontSize: 17, lineHeight: 23, color: "#FFFFFF" },
  receipt: { marginTop: spacing.xs, marginRight: spacing.xs, fontSize: 15, lineHeight: 20, fontWeight: "400" },
  evaRow: { paddingHorizontal: spacing.lg },
  evaBubble: { alignSelf: "flex-start", maxWidth: EVA_MAX_WIDTH, borderRadius: 24, paddingVertical: 14, paddingHorizontal: 18 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  status: { textAlign: "center", paddingHorizontal: spacing.xxxl, fontWeight: "400" },
  composer: { paddingBottom: COMPOSER_BOTTOM },
  banner: { paddingBottom: spacing.sm },
  pillRow: { paddingHorizontal: spacing.lg },
  menuTitle: { textAlign: "center", paddingBottom: spacing.md },
  menuRows: { marginHorizontal: -spacing.xl },
  imagesAbove: { marginBottom: spacing.xs },
  tray: { paddingTop: spacing.md },
});
