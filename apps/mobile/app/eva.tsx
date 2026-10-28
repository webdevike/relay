/**
 * One assistant's thread (`/eva?agent=<id>`: Astra, Nova, … from the host's registry, opened from
 * the Assistants list at `/assistants`, which Back returns to): a durable
 * conversation the host keeps for Isaac, separate from the Agent Inbox. The host owns the thread
 * (`useAssistantStore().threads[agent]` mirrors its snapshot while this screen is showing); this
 * screen renders it as a chat, sends a turn with `assistant.turn`, and
 * echoes the sent words and pictures until the host's next snapshot carries them. The pill's "+"
 * opens a sheet to pick library photos or paste a clipboard image; queued images show as
 * thumbnails above the field. Bubbles stack their images above the text, tap to open. The newest
 * settled reply may carry tap-to-answer reply chips (`lib/replyChips.ts`); a tap sends that label as
 * a turn, as the composer does, and leaves the draft alone.
 *
 * Look (after OpenAI's Dots chat): no title; the agent's avatar ring and name chip occupy a
 * dedicated header above the scrolling conversation (tapping them opens a menu); the user's
 * words are blue bubbles on the right with a delivery receipt, the agent's replies are dark grey bubbles
 * on the left with three typing dots while she works before her reply text streams. The rounded composer keeps multiline text
 * above a persistent row of attachment, dictation and send controls. Dictation fills the draft.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, AppState, FlatList, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, TextInput, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { assistantReactionThread, MAX_REPLY_IMAGES, type AssistantMessage } from "@relay/protocol";
import { AttachmentTray } from "@/ui/AttachmentTray";
import { AvatarRing, NAME_PILL_GAP, NAME_PILL_HEIGHT, RING_SIZE } from "@/ui/AvatarRing";
import { Banner } from "@/ui/Banner";
import { Callout } from "@/ui/Callout";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { SignInCard } from "@/ui/SignInCard";
import { Text } from "@/ui/Text";
import { MessageAppearance } from "@/ui/MessageAppearance";
import { ReplyChips } from "@/ui/ReplyChips";
import { TypingDots } from "@/ui/TypingDots";
import { ScrollToBottom } from "@/ui/ScrollToBottom";
import { useInvertedChatScroll } from "@/ui/useInvertedChatScroll";
import { useMessageEntrances } from "@/ui/useMessageEntrances";
import { ImageViewer } from "@/agents/ImageViewer";
import { MarkdownImages } from "@/agents/MarkdownImages";
import { MessageImageStack } from "@/agents/MessageImageStack";
import { topLevelImages } from "@/agents/markdown";
import { MessageText } from "@/agents/MessageText";
import { BubbleMenuProvider, ChatBubble } from "@/agents/BubbleMenu";
import { quoteIntoDraft } from "@/lib/bubbleMenu";
import { bubbleReactionKey } from "@/lib/reactions";
import { radii, spacing, useColors, useScheme } from "@/theme";
import { agentPortrait, agentTitle, threadOf, useAssistantStore } from "@/state/assistant";
import { useMotionSignals } from "@/state/motion";
import { useConnectionStore } from "@/state/connection";
import { requestAssistant, sendCommand, stopAssistant, watchArtifacts } from "@/connection";
import { notifyHaptic } from "@/lib/haptics";
import { liveReplies } from "@/lib/replyChips";
import { clipboardHasImage, readClipboardPhoto } from "@/lib/clipboard";
import { PasteImageChip } from "@/ui/PasteImageChip";
import { CallScreen } from "@/call/CallScreen";
import { startVoiceCall } from "@/call/live";
import { useCallStore } from "@/state/call";
import { useLiveCallStore } from "@/state/liveCall";
import "@/dictation/session";
import { choosePhoto, chooseLibraryPhotos, type Photo } from "@/lib/photo";
import { ArtifactsButton } from "@/artifacts/ArtifactsButton";
import { CanvasEntryRow } from "@/canvas/CanvasEntryRow";
import { draftKey, useThreadDraft } from "@/state/drafts";
import { ArtifactsSheet } from "@/artifacts/ArtifactsSheet";

/** Id of the row echoing a sent turn before the host's snapshot lists it. */
const PENDING_ID = "pending-turn";
/** The avatar ring starts this far below the status bar. */
const HEADER_TOP = 2;
/** Space below the status bar that the avatar ring and its name pill take. */
const HEADER_HEIGHT = HEADER_TOP + RING_SIZE + NAME_PILL_GAP + NAME_PILL_HEIGHT;
/** The oldest rows start this far below the header, so they open clear of the avatar. */
const HEADER_GAP = 8;
/** Gap between the pill and the bottom safe area. */
const COMPOSER_BOTTOM = spacing.md;
/** Thread background in dark mode: pure black, as Dot's; the pill and bubbles sit on it. */
const BG_DARK = "#000000";
/** Assistant bubble fill in dark mode. */
const BUBBLE_DARK = "#212121";
/** Space between rows of different senders, and between rows of one sender's run. */
const GAP_SENDER = 16;
const GAP_RUN = 4;
/** Proportion of the width a bubble may take. */
const USER_MAX_WIDTH = "80%";
const USER_RADIUS = 24;
const EVA_RADIUS = 22;
/**
 * Where each agent's thread was left, as the inverted list's offset (0 = the newest message in
 * view), as AgentCard keeps it per session: a thread that remounts opens where Isaac was.
 */
const scrollMemory = new Map<string, number>();

/** Keyed by agent, so moving to another agent's thread (a notification tap) starts with a fresh composer. */
export default function Eva() {
  const { agent } = useLocalSearchParams<{ agent: string }>();
  return <Thread key={agent} agent={agent} />;
}

function Thread({ agent }: { agent: string }) {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const title = useAssistantStore((state) => agentTitle(state.agents, agent));
  const portrait = useAssistantStore((state) => agentPortrait(state.agents, agent));
  const snapshot = useAssistantStore((state) => threadOf(state, agent).snapshot);
  const pending = useAssistantStore((state) => threadOf(state, agent).pending);
  const setPending = useAssistantStore((state) => state.setPending);
  const connected = useConnectionStore((state) => state.status === "connected");
  const [draft, setDraft] = useThreadDraft(draftKey("assistant", agent));
  const composer = useRef<TextInput>(null);
  // Where the composer's cursor is, for Reply to quote above it.
  const cursor = useRef(0);
  const [listening, setListening] = useState(false);
  const recording = useRef(false);
  const dictationBase = useRef("");
  const dictationFinal = useRef("");
  const [inputHeight, setInputHeight] = useState(40);
  const [failure, setFailure] = useState<string | null>(null);
  // A legacy call that a live call's fallback (Action Button, Call) could not start.
  const callFailure = useLiveCallStore((state) => (state.failure?.agent === agent ? state.failure.message : null));
  const banner = failure ?? callFailure;
  // The last turn sent from here was refused or timed out: the portrait shows Error until the next one.
  const [turnFailed, setTurnFailed] = useState(false);
  const signals = useMotionSignals(agent, turnFailed);
  const onCall = useCallStore((state) => state.call?.agent === agent);
  // The composer floats over the list, so the list pads itself by however tall the composer is.
  const [composerHeight, setComposerHeight] = useState(108 + COMPOSER_BOTTOM);
  // Images queued on the composer, sent with the next turn.
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The images of the tapped bubble, open in the full-screen viewer.
  const [viewing, setViewing] = useState<{ uris: string[]; start: number } | null>(null);
  // Read once per mount: coming back to the thread restores its position and follow mode.
  const initialOffset = useRef(scrollMemory.get(agent) ?? 0);
  const { listRef, awayFromBottom, scrollToBottom, followContent, scrollHandlers } = useInvertedChatScroll<AssistantMessage>({
    initialOffset: initialOffset.current,
    onOffset: (offset) => {
      scrollMemory.set(agent, offset);
    },
  });
  const viewerImages = useMemo(() => (viewing === null ? null : viewing.uris.map((uri) => ({ uri }))), [viewing]);
  const artifactsThread = assistantReactionThread(agent);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  // Follow the thread's artifacts while it shows, so the header button's dot is live.
  useEffect(() => watchArtifacts(artifactsThread), [artifactsThread]);

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
    // Dictation stops when the app leaves the foreground, as when the thread does.
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "background" && recording.current) ExpoSpeechRecognitionModule.abort();
    });
    return () => {
      appState.remove();
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
      requestAssistant(agent);
      return () => {
        stopAssistant(agent);
      };
    }, [agent]),
  );

  const text = draft.trim();
  const canSend = connected && !listening && (text !== "" || photos.length > 0);
  const full = photos.length >= MAX_REPLY_IMAGES;
  const [composing, setComposing] = useState(false);

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

  /**
   * Sends a turn: the composer's words and photos, or a tapped reply chip's label. Either shows the
   * pending echo at once; a refusal clears it and says why. Only a composer send empties the draft
   * and photos, and gets them back on failure; a chip leaves the draft alone and shows again.
   */
  const sendTurn = (words: string, sent: Photo[], fromComposer: boolean): void => {
    setFailure(null);
    setTurnFailed(false);
    setPending(agent, { text: words, images: sent });
    if (fromComposer) {
      setDraft("");
      setPhotos([]);
    }
    sendCommand({ kind: "assistant.turn", agent, text: words, ...(sent.length > 0 ? { images: sent.map((photo) => photo.image) } : {}) }).catch(
      (error: unknown) => {
        notifyHaptic("error");
        setTurnFailed(true);
        setPending(agent, null);
        // The words and pictures come back to the composer, so a lost connection never eats a message.
        if (fromComposer) {
          setDraft((current) => (current === "" ? words : current));
          setPhotos((current) => (current.length === 0 ? sent : current));
        }
        setFailure(error instanceof Error && error.message !== "" ? error.message : `Couldn't reach ${title}.`);
      },
    );
  };

  const send = (): void => {
    if (!canSend) return;
    sendTurn(text, photos, true);
  };

  // Image bytes are fetched against the omp session the thread runs in; empty while the agent is not running.
  const sessionId = snapshot === null || snapshot.sessionId === "" ? null : snapshot.sessionId;

  // Machinery is invisible: the host no longer sends job lines as `status` rows, and an older host's are not shown.
  const messages = (snapshot?.messages ?? []).filter((message) => message.role !== "status");
  const rows: AssistantMessage[] =
    pending === null ? messages : [...messages, { id: PENDING_ID, role: "user", text: pending.text, at: Date.now() }];
  const newestFirst = [...rows].reverse();
  const enteringMessages = useMessageEntrances(rows, snapshot !== null);
  const busy = snapshot?.busy === true;
  // The dots stand in for a reply that has not started: while the host says the session is working
  // and the newest row is not an assistant message already showing words. Once text streams, it is the indicator.
  const newest = newestFirst[0];
  const typing = busy && !(newest?.role === "assistant" && newest.text.trim() !== "");
  // Tap-to-answer replies under the newest reply once it has settled; hidden while offline, where a tap could not send.
  const replies = connected ? liveReplies(snapshot, pending) : null;

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
      { title, options: [`${title}'s computer`, "Mac live view", "Agent Inbox", "Cancel"], cancelButtonIndex: 3 },
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
    router.push({ pathname: "/eva-signin", params: { agent, messageId, url: signin.url, host: signin.host } });
  };

  /** Reply from a bubble's menu: its text quoted above the cursor's line, then the composer focused there. */
  const replyWith = (quoted: string): void => {
    const next = quoteIntoDraft(draft, cursor.current, quoted);
    setDraft(next.draft);
    cursor.current = next.cursor;
    requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.setSelection(next.cursor, next.cursor);
    });
  };

  const screen = (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]} edges={["bottom"]}>
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <View style={styles.fill}>
          {rows.length === 0 ? (
            <View style={[styles.fill, { paddingTop: listTop, paddingBottom: composerHeight }]}>
              <EmptyState
                symbol="bubble.left.and.text.bubble.right"
                title={`Say hi to ${title}`}
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
                    agent={agent}
                    message={item}
                    receipt={item.id === latestUserId ? receipt : null}
                    streaming={busy && index === 0 && item.role === "assistant"}
                    sessionId={sessionId}
                    local={item.id === PENDING_ID ? pending?.images : undefined}
                    replies={index === 0 ? replies : null}
                    onReply={(reply) => {
                      sendTurn(reply, [], false);
                    }}
                    onOpenImages={(uris, start) => {
                      setViewing({ uris, start });
                    }}
                    onSignIn={openSignIn}
                  />
                </MessageAppearance>
              )}
              // Inverted: the header sits at the visual bottom, below the newest row.
              ListHeaderComponent={typing ? <TypingRow title={title} gap={newest !== undefined && senderOf(newest) === "eva" ? GAP_RUN : GAP_SENDER} /> : null}
              // Inverted: reserve room at the visual bottom for the floating composer.
              contentContainerStyle={{ paddingTop: composerHeight + spacing.md }}
              contentOffset={{ x: 0, y: initialOffset.current }}
              {...scrollHandlers}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
            />
          )}
          <ScrollToBottom visible={awayFromBottom} onPress={scrollToBottom} bottom={composerHeight + spacing.sm} />
          <View pointerEvents="box-none" style={[styles.header, { top: insets.top + HEADER_TOP }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${title} menu`}
              onPress={openMenu}
            >
              <AvatarRing name={title} portrait={portrait} motion={{ signals, paused: onCall }} />
            </Pressable>
            <View style={styles.back}>
              <BackButton
                onPress={() => {
                  // Opened from Assistants it goes back there; a notification tap into a cold app has nothing behind it.
                  if (router.canGoBack()) router.back();
                  else router.replace("/assistants");
                }}
              />
            </View>
            <View style={styles.artifacts}>
              <ArtifactsButton
                thread={artifactsThread}
                tone={dark ? "overlay" : "default"}
                onPress={() => {
                  Keyboard.dismiss();
                  setArtifactsOpen(true);
                }}
              />
            </View>
            <View style={styles.call}>
              <IconButton
                symbol="phone.fill"
                tone={dark ? "overlay" : "default"}
                disabled={!connected}
                accessibilityLabel={`Call ${title}`}
                onPress={() => {
                  Keyboard.dismiss();
                  setFailure(null);
                  startVoiceCall(agent).catch((error: unknown) => {
                    setFailure(error instanceof Error && error.message !== "" ? error.message : `Couldn't call ${title}.`);
                  });
                }}
              />
            </View>
          </View>
        </View>
        {/* Pulled over the list by its own height, so the list runs under it. */}
        <View onLayout={onComposerLayout} style={[styles.composer, { marginTop: -composerHeight }]}>
          {banner !== null && (
            <View style={[styles.banner, { backgroundColor: bg }]}>
              <Banner tone="danger" message={banner} />
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
              {!full && <PasteImageChip active={composing && connected && !listening} onPaste={() => { attach("clipboard"); }} style={styles.tray} />}
              <TextInput
                ref={composer}
                value={draft}
                onChangeText={setDraft}
                onSelectionChange={(event) => {
                  cursor.current = event.nativeEvent.selection.start;
                }}
                onFocus={() => { setComposing(true); followContent(); }}
                onBlur={() => { setComposing(false); }}
                placeholder={listening ? "Listening…" : connected ? `Message ${title}` : "Not connected"}
                editable={connected && !listening}
                multiline
                keyboardAppearance={dark ? "dark" : "light"}
                placeholderTextColor={colors.textMuted}
                selectionColor={colors.accent}
                onContentSizeChange={(event) => {
                  setInputHeight(Math.max(40, Math.min(128, Math.ceil(event.nativeEvent.contentSize.height))));
                }}
                style={[styles.composerInput, { height: inputHeight, color: colors.text }]}
                accessibilityLabel={`Message ${title}`}
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
      {onCall && <CallScreen agent={agent} title={title} portrait={portrait} />}
    </SafeAreaView>
  );
  return (
    <BubbleMenuProvider thread={assistantReactionThread(agent)} onReply={replyWith}>
      <View style={styles.fill}>
        {screen}
        <ArtifactsSheet
          thread={artifactsThread}
          agent={agent}
          session={sessionId}
          open={artifactsOpen}
          onClose={() => {
            setArtifactsOpen(false);
          }}
        />
      </View>
    </BubbleMenuProvider>
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

/** The typing dots at the live edge of the inverted list, in the incoming bubble's fill. */
function TypingRow({ title, gap }: { title: string; gap: number }) {
  const colors = useColors();
  const fill = useScheme() === "dark" ? BUBBLE_DARK : colors.surface;
  return (
    <Animated.View entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
      style={[styles.evaRow, { marginTop: gap }]}>
      <TypingDots fill={fill} label={`${title} is typing`} />
    </Animated.View>
  );
}

interface RowProps {
  /** The thread's agent id, for its acked sign-ins. */
  agent: string;
  message: AssistantMessage;
  receipt: string | null;
  streaming: boolean;
  /** The omp session the thread runs in, for fetching image bytes; null while the agent is not running. */
  sessionId: string | null;
  /** The echoed turn's images, still on the phone; shown instead of the message's host refs. */
  local: Photo[] | undefined;
  onOpenImages: (uris: string[], start: number) => void;
  /** The sign-in card was tapped. */
  onSignIn: (messageId: string, signin: NonNullable<AssistantMessage["signin"]>) => void;
  /** Tap-to-answer replies to show under the bubble: only the newest settled reply gets them. */
  replies: readonly string[] | null;
  /** A reply chip was tapped: send its words as Isaac's turn. */
  onReply: (reply: string) => void;
}

function Row({ agent, message, receipt, streaming, sessionId, local, onOpenImages, onSignIn, replies, onReply }: RowProps) {
  const signedIn = useAssistantStore((state) => threadOf(state, agent).signedIn[message.id] === true);
  const colors = useColors();
  const dark = useScheme() === "dark";
  const bubbleFill = dark ? BUBBLE_DARK : colors.surface;
  const page = dark ? BG_DARK : colors.bg;
  // The echo of a turn still being sent has the phone's clock, not the host's: no reaction yet.
  const reactionKey = bubbleReactionKey(message, message.id === PENDING_ID);
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
            <ChatBubble
              messageKey={reactionKey}
              side="right"
              text={message.text}
              style={styles.userBubbleFrame}
              radius={USER_RADIUS}
              ring={page}
              accessibilityLabel={message.text}
            >
              <View style={[styles.userBubble, { backgroundColor: colors.bubbleUser }]}>
                <Text style={styles.userText}>{message.text}</Text>
              </View>
            </ChatBubble>
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
            <ChatBubble messageKey={reactionKey} side="left" text={message.text} style={styles.evaBubbleFrame} radius={EVA_RADIUS} ring={page}>
              <View style={[styles.evaBubble, { backgroundColor: bubbleFill }]}>
                <MessageText text={message.text} large skipImages streaming={streaming} />
              </View>
            </ChatBubble>
          )}
          {replies !== null && (
            <View style={styles.replies}>
              <ReplyChips replies={replies} onPick={onReply} />
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
          {message.canvas !== undefined ? (
            <CanvasEntryRow entry={message.canvas} origin={`/eva?agent=${encodeURIComponent(agent)}`} />
          ) : (
            <View style={[styles.card, { borderColor: colors.hairline }]}>
              {message.title !== undefined && message.title !== "" && <Text variant="label">{message.title}</Text>}
              <MessageText text={message.text} />
            </View>
          )}
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
  call: { position: "absolute", top: spacing.xs, right: spacing.lg },
  /** Left of the call button: its width (IconButton's 40) and a small gap further in. */
  artifacts: { position: "absolute", top: spacing.xs, right: spacing.lg + 40 + spacing.sm },
  userRow: { paddingHorizontal: spacing.lg, alignItems: "flex-end" },
  userBubbleFrame: { maxWidth: USER_MAX_WIDTH },
  userBubble: { borderRadius: USER_RADIUS, paddingVertical: 11, paddingHorizontal: 17 },
  userText: { fontSize: 17, lineHeight: 23, color: "#FFFFFF" },
  receipt: { marginTop: spacing.xs, marginRight: spacing.lg, fontSize: 13, lineHeight: 18, fontWeight: "400" },
  evaRow: { paddingHorizontal: spacing.lg },
  tiles: { alignItems: "flex-start" },
  tilesAboveCaption: { marginBottom: GAP_RUN },
  evaBubbleFrame: { alignSelf: "flex-start", maxWidth: "88%" },
  evaBubble: { borderRadius: EVA_RADIUS, paddingVertical: 11, paddingHorizontal: 17 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  status: { textAlign: "center", paddingHorizontal: spacing.xxxl, fontWeight: "400" },
  composer: { paddingBottom: COMPOSER_BOTTOM },
  banner: { paddingBottom: spacing.sm },
  pillRow: { paddingHorizontal: spacing.lg },
  composerActions: { flexDirection: "row", gap: spacing.sm },
  composerCard: { borderRadius: 28, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 4 },
  composerInput: { fontSize: 17, lineHeight: 22, paddingTop: 4, paddingBottom: 4, paddingHorizontal: 6, textAlignVertical: "top" },
  composerToolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  menuTitle: { textAlign: "center", paddingBottom: spacing.md },
  menuRows: { marginHorizontal: -spacing.xl },
  imagesAbove: { marginBottom: spacing.xs },
  signinAbove: { marginBottom: spacing.sm },
  /** Clear of the reaction badges that overlap the bubble's bottom corner. */
  replies: { marginTop: spacing.sm },
  tray: { paddingTop: spacing.md },
});
