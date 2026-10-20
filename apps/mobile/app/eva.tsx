/**
 * Eva, the personal assistant: one durable conversation the host keeps for Isaac, separate from
 * the Agent Inbox. The host owns the thread (`useAssistantStore` mirrors its snapshot while this
 * screen is showing); this screen renders it as a chat, sends a turn with `assistant.turn`, and
 * echoes the sent words and pictures until the host's next snapshot carries them. The pill's "+"
 * opens a sheet to pick library photos or paste a clipboard image; queued images show as
 * thumbnails above the field. Bubbles stack their images above the text, tap to open.
 *
 * Look (after OpenAI's Dots chat): no title; the agent's avatar ring and name chip occupy a
 * dedicated header above the scrolling conversation (tapping them opens a menu); the user's
 * words are blue bubbles on the right with a delivery receipt, Eva's replies are dark grey bubbles
 * on the left with a typing bubble while she works. The rounded composer keeps multiline text
 * above a persistent row of attachment, dictation and send controls. Dictation fills the draft.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, FlatList, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, TextInput, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import Animated, { FadeIn, FadeOut, ReduceMotion, useReducedMotion } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { MAX_REPLY_IMAGES, type AssistantMessage } from "@relay/protocol";
import { AttachmentTray } from "@/ui/AttachmentTray";
import { AvatarRing, NAME_PILL_GAP, NAME_PILL_HEIGHT, RING_SIZE } from "@/ui/AvatarRing";
import { Banner } from "@/ui/Banner";
import { Callout } from "@/ui/Callout";
import { EmptyState } from "@/ui/EmptyState";
import { ExpandableContent } from "@/ui/ExpandableContent";
import { IconButton } from "@/ui/IconButton";
import { SignInCard } from "@/ui/SignInCard";
import { Text } from "@/ui/Text";
import { MessageAppearance } from "@/ui/MessageAppearance";
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
const AGENT_NAME = "Astra";
/** The avatar ring starts this far below the status bar. */
const HEADER_TOP = 2;
/** Space below the status bar that the avatar ring and its name pill take. */
const HEADER_HEIGHT = HEADER_TOP + RING_SIZE + NAME_PILL_GAP + NAME_PILL_HEIGHT;
/** The oldest rows start this far below the header, so they open clear of the avatar. */
const HEADER_GAP = 8;
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
const EVA_MAX_WIDTH = "100%";

export default function Eva() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const snapshot = useAssistantStore((state) => state.snapshot);
  const pending = useAssistantStore((state) => state.pending);
  const setPending = useAssistantStore((state) => state.setPending);
  const connected = useConnectionStore((state) => state.status === "connected");
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const recording = useRef(false);
  const dictationBase = useRef("");
  const dictationFinal = useRef("");
  const [inputHeight, setInputHeight] = useState(40);
  const [failure, setFailure] = useState<string | null>(null);
  // The composer floats over the list, so the list pads itself by however tall the composer is.
  const [composerHeight, setComposerHeight] = useState(108 + COMPOSER_BOTTOM);
  // Images queued on the composer, sent with the next turn.
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The images of the tapped bubble, open in the full-screen viewer.
  const [viewing, setViewing] = useState<{ uris: string[]; start: number } | null>(null);
  const listRef = useRef<FlatList<AssistantMessage>>(null);
  // The list's scroll offset (0 is the newest message, the visual bottom), for anchoring "Show more".
  const offsetRef = useRef(0);
  const following = useRef(true);
  const draggingList = useRef(false);
  const scrollingToBottom = useRef(false);
  const followFrame = useRef<number | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const reducedMotion = useReducedMotion();
  const knownMessages = useRef(new Set(snapshot?.messages.map((message) => message.id) ?? []));
  const loadedHistory = useRef(snapshot !== null);
  useEffect(() => {
    if (snapshot === null) return;
    loadedHistory.current = true;
    for (const message of snapshot.messages) knownMessages.current.add(message.id);
    if (pending !== null) knownMessages.current.add(PENDING_ID);
    else knownMessages.current.delete(PENDING_ID);
  }, [snapshot, pending]);
  useEffect(() => () => {
    if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
  }, []);
  const viewerImages = useMemo(() => (viewing === null ? null : viewing.uris.map((uri) => ({ uri }))), [viewing]);

  useSpeechRecognitionEvent("result", (event) => {
    if (!recording.current) return;
    const transcript = event.results[0]?.transcript ?? "";
    setDraft([dictationBase.current, dictationFinal.current, transcript].filter(Boolean).join(" "));
    if (event.isFinal) {
      dictationFinal.current = [dictationFinal.current, transcript].filter(Boolean).join(" ");
    }
  });
  useSpeechRecognitionEvent("end", () => {
    recording.current = false;
    setListening(false);
  });
  useSpeechRecognitionEvent("error", (event) => {
    if (!recording.current) return;
    recording.current = false;
    setListening(false);
    if (event.error !== "aborted") setFailure(event.message || "Couldn't start dictation.");
  });
  const focused = useRef(false);
  const requestingMic = useRef(false);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => {
      focused.current = false;
      if (recording.current) ExpoSpeechRecognitionModule.abort();
      recording.current = false;
      setListening(false);
    };
  }, []));

  const dictate = async (): Promise<void> => {
    if (recording.current) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    if (requestingMic.current) return;
    requestingMic.current = true;
    Keyboard.dismiss();
    setFailure(null);
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) throw new Error("Speech recognition is unavailable.");
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!focused.current) return;
      if (!permission.granted) throw new Error("Allow microphone and speech recognition access in Settings to dictate.");
      dictationBase.current = draft.trim();
      dictationFinal.current = "";
      recording.current = true;
      setListening(true);
      ExpoSpeechRecognitionModule.start({
        lang: "en-US", interimResults: true, continuous: true, addsPunctuation: true, iosTaskHint: "dictation",
      });
    } catch (error) {
      recording.current = false;
      setListening(false);
      setFailure(error instanceof Error ? error.message : "Couldn't start dictation.");
    } finally {
      requestingMic.current = false;
    }
  };

  // The thread is fetched only while this screen shows; the driver re-asks on every welcome in between.
  useFocusEffect(
    useCallback(() => {
      requestAssistant();
      return () => {
        stopAssistant();
      };
    }, []),
  );

  /** Explicit navigation resumes following; streaming never takes ownership from a reader. */
  const scrollToBottom = useCallback(() => {
    following.current = true;
    setAwayFromBottom(false);
    scrollingToBottom.current = true;
    draggingList.current = false;
    listRef.current?.scrollToOffset({ offset: 0, animated: !reducedMotion });
  }, [reducedMotion]);

  const followContent = useCallback(() => {
    if (!following.current || draggingList.current) return;
    if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
    followFrame.current = requestAnimationFrame(() => {
      followFrame.current = null;
      if (following.current && !draggingList.current) {
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      }
    });
  }, []);

  const observeScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    offsetRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
    // Layout anchoring can move an inverted list's offset. Only a reader gesture unpins it.
    if (!draggingList.current) return;
    const near = offsetRef.current <= BOTTOM_STICK_PX;
    following.current = near;
    setAwayFromBottom(!near);
  };

  /** "Show more" grew a bubble by `growth`: move the offset with it so the clamp stays where it was on screen. */
  const anchorExpanded = useCallback((growth: number) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: Math.max(0, offsetRef.current + growth), animated: false });
    });
  }, []);

  const text = draft.trim();
  const canSend = connected && !listening && (text !== "" || photos.length > 0);
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
  // Capture membership before effects run; FlatList may render its cells asynchronously.
  const enteringMessages = new Set(rows.filter((message) => loadedHistory.current && !knownMessages.current.has(message.id)).map((message) => message.id));
  const busy = snapshot?.busy === true;

  // Only the newest user message carries a receipt: Sending while its echo is pending, Seen once
  // the host's snapshot lists it.
  const latestUserId = newestFirst.find((message) => message.role === "user")?.id ?? null;
  const receipt = latestUserId === null ? null : latestUserId === PENDING_ID ? "Sending" : "Seen";

  const dark = useScheme() === "dark";
  const bg = dark ? BG_DARK : colors.bg;
  const listTop = insets.top + HEADER_HEIGHT + HEADER_GAP;

  const onComposerLayout = (event: LayoutChangeEvent): void => {
    setComposerHeight(event.nativeEvent.layout.height);
  };

  /** The avatar menu: a native action sheet, since a bottom-sheet modal did not present on this screen. */
  const openMenu = (): void => {
    Keyboard.dismiss();
    ActionSheetIOS.showActionSheetWithOptions(
      { title: AGENT_NAME, options: [`${AGENT_NAME}'s computer`, "Mac live view", "Agent Inbox", "Cancel"], cancelButtonIndex: 3 },
      (index) => {
        if (index === 0) router.push("/eva-computer");
        if (index === 1) router.push("/screen");
        if (index === 2) router.push("/agents");
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

  /** Sign-in card tapped: the credentials sheet, a modal route (the bottom-sheet modal did not present on this screen). */
  const openSignIn = (messageId: string, signin: NonNullable<AssistantMessage["signin"]>): void => {
    Keyboard.dismiss();
    router.push({ pathname: "/eva-signin", params: { messageId, url: signin.url, host: signin.host } });
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
              style={[styles.fill, { marginTop: listTop }]}
              data={newestFirst}
              inverted
              keyExtractor={(message) => message.id}
              extraData={`${latestUserId ?? ""}|${receipt ?? ""}`}
              renderItem={({ item, index }) => (
                // Inverted: the next index is the older row above this one, and a row's top margin is the space above it.
                <MessageAppearance animate={enteringMessages.has(item.id)} user={item.role === "user"} gap={gapAbove(item, newestFirst[index + 1])}>
                  <Row
                    message={item}
                    receipt={item.id === latestUserId ? receipt : null}
                    streaming={busy && index === 0 && item.role === "assistant"}
                    sessionId={sessionId}
                    local={item.id === PENDING_ID ? pending?.images : undefined}
                    onOpenImages={(uris, start) => {
                      setViewing({ uris, start });
                    }}
                    onExpanded={anchorExpanded}
                    onSignIn={openSignIn}
                  />
                </MessageAppearance>
              )}
              // Inverted: the header sits at the visual bottom, below the newest row.
              ListHeaderComponent={busy ? <TypingRow streaming={newestFirst[0]?.role === "assistant"} gap={newestFirst[0]?.role === "user" ? GAP_SENDER : GAP_RUN} /> : null}
              // Inverted: reserve room at the visual bottom for the floating composer.
              contentContainerStyle={{ paddingTop: composerHeight + spacing.md }}
              maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              onContentSizeChange={followContent}
              onScroll={observeScroll}
              onScrollBeginDrag={() => { scrollingToBottom.current = false; draggingList.current = true; }}
              onScrollEndDrag={(event) => { observeScroll(event); draggingList.current = false; }}
              onMomentumScrollBegin={() => { if (!scrollingToBottom.current) draggingList.current = true; }}
              onMomentumScrollEnd={(event) => {
                if (!scrollingToBottom.current) observeScroll(event);
                scrollingToBottom.current = false;
                draggingList.current = false;
              }}
              scrollEventThrottle={16}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
            />
          )}
          {awayFromBottom && (
            <Animated.View entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(160).reduceMotion(ReduceMotion.System)}
              style={[styles.jump, { bottom: composerHeight + spacing.sm }]}>
              <Pressable accessibilityRole="button" accessibilityLabel="Scroll to bottom" onPress={scrollToBottom}
                style={({ pressed }) => [styles.jumpButton, { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline, opacity: pressed ? 0.8 : 1 }]}>
                <SymbolView name="arrow.down" size={16} tintColor={colors.text} />
                <Text style={styles.jumpLabel}>Scroll to bottom</Text>
              </Pressable>
            </Animated.View>
          )}
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
            <View style={[styles.composerCard, { backgroundColor: dark ? BUBBLE_DARK : colors.surface, borderColor: colors.hairline }]}>
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
              <TextInput
                value={draft}
                onChangeText={setDraft}
                onFocus={followContent}
                placeholder={listening ? "Listening…" : connected ? "Message Eva" : "Not connected"}
                editable={connected && !listening}
                multiline
                keyboardAppearance={dark ? "dark" : "light"}
                placeholderTextColor={colors.textMuted}
                selectionColor={colors.accent}
                onContentSizeChange={(event) => {
                  setInputHeight(Math.max(40, Math.min(128, Math.ceil(event.nativeEvent.contentSize.height))));
                }}
                style={[styles.composerInput, { height: inputHeight, color: colors.text }]}
                accessibilityLabel="Message Eva"
              />
              <View style={styles.composerToolbar}>
                <AttachButton onPress={openAttach} disabled={!connected || listening} />
                <View style={styles.composerActions}>
                  <DictateButton onPress={() => { void dictate(); }} active={listening} disabled={!connected} />
                  <SendButton onPress={send} disabled={!canSend} />
                </View>
              </View>
            </View>
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

/** Composer actions stay visible in the bottom row, including the disabled send arrow. */
function AttachButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const colors = useColors();
  return <IconButton symbol="plus" size={44} glyphSize={24} onPress={onPress} disabled={disabled}
    backgroundColor={colors.hairline} accessibilityLabel="Attach image" />;
}

function DictateButton({ onPress, active, disabled }: { onPress: () => void; active: boolean; disabled: boolean }) {
  const colors = useColors();
  return <IconButton symbol={active ? "stop.fill" : "mic"} size={44} glyphSize={21} onPress={onPress} disabled={disabled}
    backgroundColor={active ? colors.accent : colors.hairline}
    accessibilityLabel={active ? "Stop dictation" : "Dictate message"} />;
}

function SendButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const colors = useColors();
  return <IconButton symbol="arrow.up" size={44} glyphSize={21} onPress={onPress} disabled={disabled} disabledOpacity={0.8}
    backgroundColor={disabled ? colors.hairline : colors.bubbleUser}
    tintColor={disabled ? colors.textMuted : "#FFFFFF"} accessibilityLabel="Send" />;
}

/** Space above a row: the sender gap when the row above (older) is by someone else, the run gap when it is by the same one. */
function gapAbove(message: AssistantMessage, above: AssistantMessage | undefined): number {
  if (above === undefined) return 0;
  return senderOf(message) === senderOf(above) ? GAP_RUN : GAP_SENDER;
}

function senderOf(message: AssistantMessage): "user" | "status" | "eva" {
  return message.role === "user" ? "user" : message.role === "status" ? "status" : "eva";
}

/** The typing bubble, as the newest row while Eva is working. */
function TypingRow({ gap, streaming }: { gap: number; streaming: boolean }) {
  return (
    <View style={[styles.evaRow, { marginTop: gap }]}>
      <TypingBubble streaming={streaming} />
    </View>
  );
}

interface RowProps {
  message: AssistantMessage;
  receipt: string | null;
  streaming: boolean;
  /** The omp session the thread runs in, for fetching image bytes; null while Eva is not running. */
  sessionId: string | null;
  /** The echoed turn's images, still on the phone; shown instead of the message's host refs. */
  local: Photo[] | undefined;
  onOpenImages: (uris: string[], start: number) => void;
  /** An assistant bubble's "Show more" grew it by this much. */
  onExpanded: (growth: number) => void;
  /** The sign-in card was tapped. */
  onSignIn: (messageId: string, signin: NonNullable<AssistantMessage["signin"]>) => void;
}

function Row({ message, receipt, streaming, sessionId, local, onOpenImages, onExpanded, onSignIn }: RowProps) {
  const signedIn = useAssistantStore((state) => state.signedIn[message.id] === true);
  const colors = useColors();
  const bubbleFill = colors.surface;
  const streamed = useRef(streaming);
  if (streaming) streamed.current = true;
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
      const { signin } = message;
      const showBubble = hasBody || (imageCount === 0 && tiles.length === 0 && signin === undefined);
      return (
        <View style={styles.evaRow}>
          {signin !== undefined && (
            <View style={showBubble || imageCount > 0 || tiles.length > 0 ? styles.signinAbove : undefined}>
              <SignInCard
                host={signin.host}
                submitted={signin.submitted === true || signedIn}
                fill={bubbleFill}
                onPress={() => {
                  onSignIn(message.id, signin);
                }}
              />
            </View>
          )}
          {images("flex-start")}
          {tiles.length > 0 && (
            <View style={[styles.tiles, hasBody && styles.tilesAboveCaption]}>
              <MarkdownImages images={tiles} />
            </View>
          )}
          {showBubble && (
            <View style={[styles.evaBubble, { backgroundColor: bubbleFill, borderColor: colors.hairline }]}>
              {streamed.current ? <MessageText text={message.text} large skipImages streaming={streaming} /> : (
                <ExpandableContent maxHeight={BUBBLE_MAX_HEIGHT} fadeHeight={BUBBLE_FADE_HEIGHT} fadeColor={bubbleFill} onExpanded={onExpanded}>
                  <MessageText text={message.text} large skipImages />
                </ExpandableContent>
              )}
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
  evaBubble: { alignSelf: "flex-start", maxWidth: EVA_MAX_WIDTH, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  status: { textAlign: "center", paddingHorizontal: spacing.xxxl, fontWeight: "400" },
  composer: { paddingBottom: COMPOSER_BOTTOM },
  banner: { paddingBottom: spacing.sm },
  pillRow: { paddingHorizontal: spacing.lg },
  composerActions: { flexDirection: "row", gap: spacing.sm },
  composerCard: { borderRadius: 28, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 4 },
  composerInput: { fontSize: 17, lineHeight: 22, paddingTop: 4, paddingBottom: 4, paddingHorizontal: 6, textAlignVertical: "top" },
  composerToolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  jump: { position: "absolute", right: spacing.lg },
  jumpButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: 22, paddingHorizontal: spacing.md },
  jumpLabel: { fontSize: 13, lineHeight: 18 },
  menuTitle: { textAlign: "center", paddingBottom: spacing.md },
  menuRows: { marginHorizontal: -spacing.xl },
  imagesAbove: { marginBottom: spacing.xs },
  signinAbove: { marginBottom: spacing.sm },
  tray: { paddingTop: spacing.md },
});
