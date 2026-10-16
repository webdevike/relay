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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, FlatList, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { MAX_REPLY_IMAGES, type AssistantMessage } from "@relay/protocol";
import { AttachmentTray } from "@/ui/AttachmentTray";
import { AvatarRing, NAME_PILL_GAP, NAME_PILL_HEIGHT, RING_SIZE } from "@/ui/AvatarRing";
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
import { MarkdownImages } from "@/agents/MarkdownImages";
import { MessageImageStack } from "@/agents/MessageImageStack";
import { topLevelImages } from "@/agents/markdown";
import { LARGE_BODY, MessageText } from "@/agents/MessageText";
import { radii, spacing, useColors, useScheme } from "@/theme";
import { useAssistantStore } from "@/state/assistant";
import { useConnectionStore } from "@/state/connection";
import { requestAssistant, sendCommand, stopAssistant } from "@/connection";
import { notifyHaptic } from "@/lib/haptics";
import { clipboardHasImage, readClipboardPhoto } from "@/lib/clipboard";
import { choosePhoto, chooseLibraryPhotos, type Photo } from "@/lib/photo";

/** Within this many points of the newest message, a new one keeps the list pinned to it. */
const BOTTOM_STICK_PX = 80;
/** Id of the row echoing a sent turn before the host's snapshot lists it. */
const PENDING_ID = "pending-turn";
/** Name on the chip under the avatar ring. */
const AGENT_NAME = "Eva";
/** The avatar ring starts this far below the status bar. */
const HEADER_TOP = 2;
/** Space below the status bar that the avatar ring and its name pill take. */
const HEADER_HEIGHT = HEADER_TOP + RING_SIZE + NAME_PILL_GAP + NAME_PILL_HEIGHT;
/** The oldest rows start this far below the header, so they open clear of the avatar. */
const HEADER_GAP = 8;
/** The blur and the dark gradient end at the ring's bottom edge. */
const FADE_BELOW_INSET = HEADER_TOP + RING_SIZE;
/** Opacity of the black gradient at the top edge of the blurred zone. */
const FADE_STRENGTH = 0.9;
/** Gap between the pill and the bottom safe area. */
const COMPOSER_BOTTOM = spacing.md;
/** An assistant bubble shows about 20 lines of text before "Show more". */
const BUBBLE_MAX_HEIGHT = 22 * 20;
/** The clamp's bottom edge fades out over two lines. */
const BUBBLE_FADE_HEIGHT = 2 * LARGE_BODY.lineHeight;
/** Thread background in dark mode: pure black, as Dot's; the pill and bubbles sit on it. */
const BG_DARK = "#000000";
/** Assistant bubble fill in dark mode. */
const BUBBLE_DARK = "#212121";
/** Space between rows of different senders, and between rows of one sender's run. */
const GAP_SENDER = 16;
const GAP_RUN = 4;
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
  // The composer floats over the list, so the list pads itself by however tall the composer is.
  const [composerHeight, setComposerHeight] = useState(PILL_HEIGHT + COMPOSER_BOTTOM);
  // Images queued on the composer, sent with the next turn.
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The images of the tapped bubble, open in the full-screen viewer.
  const [viewing, setViewing] = useState<{ uris: string[]; start: number } | null>(null);
  const listRef = useRef<FlatList<AssistantMessage>>(null);
  // The list's scroll offset (0 is the newest message, the visual bottom), for anchoring "Show more".
  const offsetRef = useRef(0);
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

  /** Always back to the newest message, whether or not the list was pinned there. */
  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // Sending adds the echo row; scroll once it has laid out.
  useEffect(() => {
    if (pending === null) return;
    const frame = requestAnimationFrame(scrollToBottom);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [pending, scrollToBottom]);

  /** "Show more" grew a bubble by `growth`: move the offset with it so the clamp stays where it was on screen. */
  const anchorExpanded = useCallback((growth: number) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: Math.max(0, offsetRef.current + growth), animated: false });
    });
  }, []);

  const text = draft.trim();
  const canSend = connected && (text !== "" || photos.length > 0);
  const full = photos.length >= MAX_REPLY_IMAGES;

  const attach = (source: "camera" | "library" | "clipboard"): void => {
    setFailure(null);
    const single = (photo: Photo | null): Photo[] => (photo === null ? [] : [photo]);
    const picked =
      source === "library"
        ? chooseLibraryPhotos(MAX_REPLY_IMAGES - photos.length)
        : source === "camera"
          ? choosePhoto("camera").then(single)
          : readClipboardPhoto().then(single);
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
    setPending({ text, images: sent });
    setDraft("");
    setPhotos([]);
    sendCommand({ kind: "assistant.turn", text, ...(sent.length > 0 ? { images: sent.map((photo) => photo.image) } : {}) }).catch(
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

  // Machinery is invisible: the host no longer sends job lines as `status` rows, and an older host's are not shown.
  const messages = (snapshot?.messages ?? []).filter((message) => message.role !== "status");
  const rows: AssistantMessage[] =
    pending === null ? messages : [...messages, { id: PENDING_ID, role: "user", text: pending.text, at: Date.now() }];
  const newestFirst = [...rows].reverse();
  const busy = snapshot?.busy === true;

  // Only the newest user message carries a receipt: Sending while its echo is pending, Seen once
  // the host's snapshot lists it.
  const latestUserId = newestFirst.find((message) => message.role === "user")?.id ?? null;
  const receipt = latestUserId === null ? null : latestUserId === PENDING_ID ? "Sending" : "Seen";

  const dark = useScheme() === "dark";
  const bg = dark ? BG_DARK : colors.bg;
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
            options: ["Camera", "Photo library", has ? "Paste image" : "Paste image (none on the clipboard)", "Cancel"],
            cancelButtonIndex: 3,
            disabledButtonIndices: full ? [0, 1, 2] : has ? [] : [2],
          },
          (index) => {
            if (index === 0) attach("camera");
            if (index === 1) attach("library");
            if (index === 2) attach("clipboard");
          },
        );
      },
      () => {
        setFailure("Couldn't read the clipboard.");
      },
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]} edges={["bottom"]}>
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
              ref={listRef}
              style={styles.fill}
              data={newestFirst}
              inverted
              keyExtractor={(message) => message.id}
              extraData={`${latestUserId ?? ""}|${receipt ?? ""}`}
              renderItem={({ item, index }) => (
                // Inverted: the next index is the older row above this one, and a row's top margin is the space above it.
                <View style={{ marginTop: gapAbove(item, newestFirst[index + 1]) }}>
                  <Row
                    message={item}
                    receipt={item.id === latestUserId ? receipt : null}
                    sessionId={sessionId}
                    local={item.id === PENDING_ID ? pending?.images : undefined}
                    onOpenImages={(uris, start) => {
                      setViewing({ uris, start });
                    }}
                    onExpanded={anchorExpanded}
                  />
                </View>
              )}
              // Inverted: the header sits at the visual bottom, below the newest row.
              ListHeaderComponent={busy ? <TypingRow gap={newestFirst[0]?.role === "user" ? GAP_SENDER : GAP_RUN} /> : null}
              // Inverted: the top padding is the visual bottom (above the composer), the bottom
              // padding the visual top (below the avatar).
              contentContainerStyle={{ paddingTop: composerHeight + spacing.md, paddingBottom: listTop }}
              maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: BOTTOM_STICK_PX }}
              onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
                offsetRef.current = event.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={16}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
            />
          )}
          <TopBlur height={topZone} />
          <EdgeFade color={bg} height={topZone} strength={FADE_STRENGTH} solid={0} />
          <View pointerEvents="box-none" style={[styles.header, { top: insets.top + HEADER_TOP }]}>
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
            <View style={[styles.banner, { backgroundColor: bg }]}>
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
                onFocus={scrollToBottom}
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

/** Space above a row: the sender gap when the row above (older) is by someone else, the run gap when it is by the same one. */
function gapAbove(message: AssistantMessage, above: AssistantMessage | undefined): number {
  if (above === undefined) return 0;
  return senderOf(message) === senderOf(above) ? GAP_RUN : GAP_SENDER;
}

function senderOf(message: AssistantMessage): "user" | "status" | "eva" {
  return message.role === "user" ? "user" : message.role === "status" ? "status" : "eva";
}

/** The typing bubble, as the newest row while Eva is working. */
function TypingRow({ gap }: { gap: number }) {
  return (
    <View style={[styles.evaRow, { marginTop: gap }]}>
      <TypingBubble />
    </View>
  );
}

interface RowProps {
  message: AssistantMessage;
  receipt: string | null;
  /** The omp session the thread runs in, for fetching image bytes; null while Eva is not running. */
  sessionId: string | null;
  /** The echoed turn's images, still on the phone; shown instead of the message's host refs. */
  local: Photo[] | undefined;
  onOpenImages: (uris: string[], start: number) => void;
  /** An assistant bubble's "Show more" grew it by this much. */
  onExpanded: (growth: number) => void;
}

function Row({ message, receipt, sessionId, local, onOpenImages, onExpanded }: RowProps) {
  const colors = useColors();
  const bubbleFill = useScheme() === "dark" ? BUBBLE_DARK : colors.surface;
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
            <View style={[styles.userBubble, { backgroundColor: colors.bubbleUser }]}>
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
    case "assistant": {
      // Markdown images Eva embeds stack above the bubble as tiles, as Dot's do; the prose keeps its bubble.
      const { images: tiles, hasBody } = topLevelImages(message.text);
      return (
        <View style={styles.evaRow}>
          {images("flex-start")}
          {tiles.length > 0 && (
            <View style={[styles.tiles, hasBody && styles.tilesAboveCaption]}>
              <MarkdownImages images={tiles} />
            </View>
          )}
          {(hasBody || (imageCount === 0 && tiles.length === 0)) && (
            <View style={[styles.evaBubble, { backgroundColor: bubbleFill }]}>
              <ExpandableContent maxHeight={BUBBLE_MAX_HEIGHT} fadeHeight={BUBBLE_FADE_HEIGHT} fadeColor={bubbleFill} onExpanded={onExpanded}>
                <MessageText text={message.text} large skipImages />
              </ExpandableContent>
            </View>
          )}
        </View>
      );
    }
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
  header: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  back: { position: "absolute", top: spacing.xs, left: spacing.lg },
  userRow: { paddingHorizontal: spacing.lg, alignItems: "flex-end" },
  userBubble: { maxWidth: USER_MAX_WIDTH, borderRadius: 24, paddingVertical: 11, paddingHorizontal: 17 },
  userText: { fontSize: 17, lineHeight: 23, color: "#FFFFFF" },
  receipt: { marginTop: spacing.xs, marginRight: spacing.lg, fontSize: 13, lineHeight: 18, fontWeight: "400" },
  evaRow: { paddingHorizontal: spacing.lg },
  tiles: { alignItems: "flex-start" },
  tilesAboveCaption: { marginBottom: GAP_RUN },
  evaBubble: { alignSelf: "flex-start", maxWidth: EVA_MAX_WIDTH, borderRadius: 24, padding: 16 },
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
