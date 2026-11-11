/**
 * One assistant's thread (`/eva?agent=<id>`: Astra, Nova, … from the host's registry, opened from
 * the Assistants list at `/assistants`, which Back returns to): a durable
 * conversation the host keeps for Isaac, separate from the Agent Inbox. The host owns the thread
 * (`useAssistantStore().threads[agent]` mirrors its snapshot while this screen is showing); this
 * screen renders it as a chat, sends a turn with `assistant.turn`, and
 * echoes the sent words and pictures until the host's next snapshot carries them. The pill's "+"
 * opens a sheet for the camera or library photos, and the field's own Paste attaches a copied image; queued images show as
 * thumbnails above the field. Bubbles stack their images above the text, tap to open. The newest
 * settled reply may carry tap-to-answer reply chips (`lib/replyChips.ts`); a tap sends that label as
 * a turn, as the composer does, and leaves the draft alone. While the thread's omp session is
 * blocked on an `ask` or a tool approval, its card sits above the composer (the session is
 * subscribed while the thread shows, as the Agent Inbox does). Questions the assistant asked that
 * Isaac has not answered (`snapshot.asks`) are counted on the header's question button, which
 * opens `agents/OpenAsksSheet` to answer or dismiss each; what runs now shows as chips under the
 * header row (`agents/RunningChips`).
 *
 * Look: one compact frosted header row (`ui/FrostedBar`: back, the agent's small animated portrait
 * with name and status, which opens a menu, then questions, artifacts and call) that the
 * conversation scrolls under; the user's
 * words are blue bubbles on the right with a delivery receipt, the agent's replies are dark grey bubbles
 * on the left with three typing dots while she works before her reply text streams. The rounded composer keeps multiline text
 * above a persistent row of attachment, hold-to-talk mic and send controls. The mic is the Agent Inbox's: hold to talk, release to send.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, FlatList, Keyboard, Pressable, StyleSheet, View, type LayoutChangeEvent, type TextInput } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import Animated, { FadeIn, FadeOut, ReduceMotion, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { expectKeyboard, keyboardHeight } from "@/lib/keyboardMotion";
import { answerText, assistantReactionThread, MAX_ASK_ANSWER, MAX_REPLY_IMAGES, splitRoomCards, stripAnswerContext, type AssistantMessage, type OpenAsk } from "@relay/protocol";
import { AvatarTitle } from "@/ui/AvatarTitle";
import { FrostedBar } from "@/ui/FrostedBar";
import { Banner } from "@/ui/Banner";
import { Callout } from "@/ui/Callout";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { SignInCard } from "@/ui/SignInCard";
import { RoomCardRow } from "@/rooms/RoomCardRow";
import { Text } from "@/ui/Text";
import { MessageAppearance } from "@/ui/MessageAppearance";
import { ReplyChips } from "@/ui/ReplyChips";
import { TypingDots } from "@/ui/TypingDots";
import { ScrollToBottom } from "@/ui/ScrollToBottom";
import { useInvertedChatScroll } from "@/ui/useInvertedChatScroll";
import { useMessageEntrances } from "@/ui/useMessageEntrances";
import { ImageViewer } from "@/agents/ImageViewer";
import { MessageImageStack } from "@/agents/MessageImageStack";
import { bubbleSegments, topLevelImages } from "@/agents/markdown";
import { MessageText } from "@/agents/MessageText";
import { BackgroundRow } from "@/agents/BackgroundRow";
import { AskCard } from "@/agents/AskCard";
import { SessionApprovalCard } from "@/agents/SessionApprovalCard";
import { usePendingAsk } from "@/agents/usePendingAsk";
import { ownedBy, useAgentsStore } from "@/state/agents";
import { useActivityStore } from "@/state/activity";
import { runningChips } from "@/lib/activity";
import { ReplyWidgetActions } from "@/agents/WidgetActions";
import { backgroundOf } from "@/lib/background";
import { guestRowKind } from "@/lib/guests";
import { GuestBubble, GuestLine, WorkCardRow } from "@/agents/GuestRows";
import { BubbleMenuProvider, ChatBubble } from "@/agents/BubbleMenu";
import { quoteIntoDraft } from "@/lib/bubbleMenu";
import { bubbleReactionKey } from "@/lib/reactions";
import { radii, spacing, useColors, useScheme } from "@/theme";
import { agentPortrait, agentTitle, threadOf, useAssistantStore } from "@/state/assistant";
import { useMotionSignals } from "@/state/motion";
import { useConnectionStore } from "@/state/connection";
import { requestAgentOptions, requestAssistant, sendCommand, stopAssistant, subscribeAgent, unsubscribeAgent, watchArtifacts } from "@/connection";
import { warn } from "@/connection/log";
import { notifyHaptic } from "@/lib/haptics";
import { liveReplies } from "@/lib/replyChips";
import { photoOfImage } from "@/lib/clipboard";
import { userImageUrls } from "@evaos/chat-core/image-urls";
import { MarkdownImages } from "@/agents/MarkdownImages";
import { RenderMessage } from "@/agents/RenderReportContext";
import { usePasteImage } from "@/lib/pasteImage";
import { CallScreen } from "@/call/CallScreen";
import { startVoiceCall } from "@/call/live";
import { useCallStore } from "@/state/call";
import { useLiveCallStore } from "@/state/liveCall";
import { ListeningOrb } from "@/dictation/ListeningOrb";
import { resetDictationTarget, setDictationTarget } from "@/dictation/deliver";
import { useDictation } from "@/dictation/useDictation";
import { useWalkieOrb } from "@/dictation/walkie";
import { AssistantComposer } from "@/agents/AssistantComposer";
import { ThinkingPopover, type PopoverAnchor } from "@/agents/ThinkingPopover";
import { COMPOSER_PILL_HEIGHT } from "@/ui/ComposerPill";
import { choosePhoto, chooseLibraryPhotos, type Photo } from "@/lib/photo";
import { ArtifactsButton } from "@/artifacts/ArtifactsButton";
import { CanvasEntryRow } from "@/canvas/CanvasEntryRow";
import { draftKey, useThreadDraft } from "@/state/drafts";
import { ArtifactsSheet } from "@/artifacts/ArtifactsSheet";
import { OpenAsksButton } from "@/agents/OpenAsksButton";
import { OpenAsksSheet } from "@/agents/OpenAsksSheet";
import { RunningChips } from "@/agents/RunningChips";
import { AskInlineCard } from "@/agents/AskInlineCard";
import { WaitingMark } from "@/ui/WaitingMark";
import { askCards, askRowId, askRowTarget, isAskRow, pruneHidden, visibleAsks, waitingMessageIds, withAskRows } from "@/lib/openAsks";
import { WidgetCloseProvider } from "@/agents/WidgetActions";
import { isLocalRow, localRowsOf, useLocalRowsStore } from "@/state/localRows";
import { assistantTurnRows } from "@/turns/rows";
import { useTurnBookmarks } from "@/turns/useTurnBookmarks";

/** Id of the row echoing a sent turn before the host's snapshot lists it. */
const PENDING_ID = "pending-turn";
/** The header's one row: back, identity and buttons, under the status bar. */
const HEADER_ROW = 44;
/** The header's round glyph buttons. */
const HEADER_BUTTON = 36;
/** The oldest rows start this far below the header. */
const HEADER_GAP = 8;
/** Gap between the idle pill and the bottom safe area: low, just above the home indicator, as the Claude app's. */
const COMPOSER_BOTTOM = spacing.xs;
/** Gap between the open card and the keyboard. */
const KEYBOARD_GAP = spacing.sm;
/** Thread background in dark mode: pure black, as Dot's; the pill and bubbles sit on it. */
const BG_DARK = "#000000";
/** Assistant bubble fill in dark mode. */
const BUBBLE_DARK = "#212121";
/** Space between rows of different senders, and between rows of one sender's run. */
const GAP_SENDER = 16;
const GAP_RUN = 4;
/** After Show in chat's scroll starts, how long before the row rings: the smooth scroll has mostly landed. */
const RING_DELAY_MS = 420;
/** Show in chat waits for the questions sheet to start closing before it scrolls. */
const SHEET_CLOSE_MS = 250;
/** Proportion of the width a bubble may take. */
const USER_MAX_WIDTH = "80%";
const USER_RADIUS = 24;
const EVA_RADIUS = 22;
/**
 * Where each agent's thread was left: the inverted list's offset (0 = the newest message in view)
 * and how many rows it held, as AgentCard keeps the offset per session: a thread that remounts
 * opens where Isaac was, with the history he had scrolled back to.
 */
const scrollMemory = new Map<string, { offset: number; drawn: number }>();
/**
 * Rows the list holds at first, newest first; nearing the oldest held row adds this many more. A
 * thread keeps every context it ever had (Nova's: 7,000+ rows), and the list measures and lays out
 * every row it holds, so history comes in as Isaac scrolls back to it.
 */
const PAGE = 40;
/**
 * Screens of rows kept drawn around the visible one (2 above, 2 below). The list's default, 21,
 * kept ten screens of images, videos, widgets and web views alive on each side of a long thread.
 */
const WINDOW_SCREENS = 5;

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
  // The dictation pipeline, from pressing the mic to the words being sent: no image pastes meanwhile.
  const dictationPhase = useDictation().phase;
  const listening = dictationPhase === "listening" || dictationPhase === "finishing" || dictationPhase === "sending";
  const [failure, setFailure] = useState<string | null>(null);
  // A legacy call that a live call's fallback (Action Button, Call) could not start.
  const callFailure = useLiveCallStore((state) => (state.failure?.agent === agent ? state.failure.message : null));
  const banner = failure ?? callFailure;
  // The last turn sent from here was refused or timed out: the portrait shows Error until the next one.
  const [turnFailed, setTurnFailed] = useState(false);
  const signals = useMotionSignals(agent, turnFailed);
  const onCall = useCallStore((state) => state.call?.agent === agent);
  // The composer floats over the list, so the list pads itself by however tall the composer is: the
  // banner and ask cards above the pill (`stack`) plus the pill, whose height animates on the UI thread.
  const [stackHeight, setStackHeight] = useState(0);
  const stack = useSharedValue(0);
  const pillHeight = useSharedValue(COMPOSER_PILL_HEIGHT);
  // The keyboard, frame by frame on the UI thread (`lib/keyboardMotion`: started by the composer's
  // tap, on the keyboard's own curve): the composer and the list ride on it as a transform, so nothing
  // re-lays out while it moves.
  const bottomInset = insets.bottom;
  // One style object per view (the list's and the composer's), the same lift in both.
  const listLiftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, keyboardHeight.value + KEYBOARD_GAP - bottomInset - COMPOSER_BOTTOM) }],
  }));
  const composerLiftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, keyboardHeight.value + KEYBOARD_GAP - bottomInset - COMPOSER_BOTTOM) }],
  }));
  // Inverted list: room at its visual bottom for the composer, so the newest message sits fully above the pill and rises with the card.
  const reserveStyle = useAnimatedStyle(() => ({ height: stack.value + pillHeight.value + COMPOSER_BOTTOM + spacing.md }));
  const emptyStyle = useAnimatedStyle(() => ({ paddingBottom: stack.value + pillHeight.value + COMPOSER_BOTTOM }));
  const overComposerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -(stack.value + pillHeight.value + COMPOSER_BOTTOM) }] }));
  // The list is lifted with the keyboard, which pushes its oldest end under the header: pad that end by as much while it is up.
  const [keyboardRoom, setKeyboardRoom] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardWillShow", (event) => {
      setKeyboardRoom(Math.max(0, event.endCoordinates.height - bottomInset));
    });
    const hidden = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardRoom(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [bottomInset]);
  // The thinking-level popover, over the composer's model chip.
  const [thinkingAnchor, setThinkingAnchor] = useState<PopoverAnchor | null>(null);
  // Images queued on the composer, sent with the next turn.
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The images of the tapped bubble, open in the full-screen viewer.
  const [viewing, setViewing] = useState<{ uris: string[]; start: number } | null>(null);
  // Read once per mount: coming back to the thread restores its position, follow mode and loaded
  // history; one left at its newest row starts again from the newest page.
  const kept = scrollMemory.get(agent);
  const memory = useRef(kept === undefined || kept.offset < 1 ? { offset: 0, drawn: PAGE } : kept);
  scrollMemory.set(agent, memory.current);
  const initialOffset = useRef(memory.current.offset);
  // Rows the list holds, newest first: a page more each time Isaac nears the oldest one held.
  const [drawn, setDrawn] = useState(memory.current.drawn);
  useEffect(() => {
    memory.current.drawn = drawn;
  }, [drawn]);
  const { listRef, awayFromBottom, scrollToBottom, scrollToRow, followContent, scrollHandlers } = useInvertedChatScroll<AssistantMessage>({
    initialOffset: initialOffset.current,
    onOffset: (offset) => {
      memory.current.offset = offset;
    },
  });
  const viewerImages = useMemo(() => (viewing === null ? null : viewing.uris.map((uri) => ({ uri }))), [viewing]);
  const artifactsThread = assistantReactionThread(agent);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  // The Artifacts tab the sheet opens on: the Working group when a running chip that is not a session was tapped.
  const [artifactsTab, setArtifactsTab] = useState<string | null>(null);
  const [asksOpen, setAsksOpen] = useState(false);
  // The frosted header floats over the list, so the list pads itself by however tall the header is.
  const [headerHeight, setHeaderHeight] = useState(insets.top + HEADER_ROW);
  // Follow the thread's artifacts while it shows, so the header button's dot is live.
  useEffect(() => watchArtifacts(artifactsThread), [artifactsThread]);
  // Rows this screen adds to the thread (the avatar editor) go with it.
  const localRows = useLocalRowsStore((state) => localRowsOf(state, agent));
  useEffect(() => () => { useLocalRowsStore.getState().clear(agent); }, [agent]);

  // The thread is fetched only while this screen shows; the driver re-asks on every welcome in between.
  useFocusEffect(
    useCallback(() => {
      requestAssistant(agent);
      return () => {
        stopAssistant(agent);
      };
    }, [agent]),
  );

  const full = photos.length >= MAX_REPLY_IMAGES;
  const [composing, setComposing] = useState(false);

  const attach = (source: "camera" | "library"): void => {
    setFailure(null);
    const picked = source === "library" ? chooseLibraryPhotos(MAX_REPLY_IMAGES - photos.length) : choosePhoto("camera").then((photo) => (photo === null ? [] : [photo]));
    picked.then(
      (added) => {
        setPhotos((current) => [...current, ...added].slice(0, MAX_REPLY_IMAGES));
      },
      (error: unknown) => {
        setFailure(error instanceof Error && error.message !== "" ? error.message : "Couldn't attach the image.");
      },
    );
  };
  // Long-press Paste in the field attaches a copied image (native `modules/paste-image`), shown in the tray like a picked photo.
  usePasteImage(composing && connected && !listening && !full, (image) => {
    setPhotos((current) => [...current, photoOfImage(image)].slice(0, MAX_REPLY_IMAGES));
  });

  /**
   * Sends a turn: the composer's words and photos, or a tapped reply chip's label. Either shows the
   * pending echo at once; a refusal clears it and says why. Only a composer send empties the draft
   * and photos, and gets them back on failure; a chip leaves the draft alone and shows again.
   */
  const sendTurn = (words: string, sent: Photo[], fromComposer: boolean): void => {
    if (fromComposer) {
      setDraft("");
      setPhotos([]);
    }
    const delivery = sendCommand({ kind: "assistant.turn", agent, text: words, ...(sent.length > 0 ? { images: sent.map((photo) => photo.image) } : {}) });
    trackTurn(words, sent, delivery, (error) => {
      // The words and pictures come back to the composer, so a lost connection never eats a message.
      if (fromComposer) {
        setDraft((current) => (current === "" ? words : current));
        setPhotos((current) => (current.length === 0 ? sent : current));
      }
      setFailure(error instanceof Error && error.message !== "" ? error.message : `Couldn't reach ${title}.`);
    });
  };

  /** Shows a turn in flight as the pending echo; a refusal clears it, marks the portrait and hands the error to `fail`. */
  const trackTurn = (words: string, sent: Photo[], delivery: Promise<void>, fail: (error: unknown) => void): void => {
    setFailure(null);
    setTurnFailed(false);
    setPending(agent, { text: words, images: sent });
    delivery.catch((error: unknown) => {
      notifyHaptic("error");
      setTurnFailed(true);
      setPending(agent, null);
      fail(error);
    });
  };

  // Hold-to-talk delivers what was heard as Isaac's next turn, to this thread; a tap dictation
  // borrows the target for the composer's field and points it back here when it ends.
  const trackTurnRef = useRef(trackTurn);
  trackTurnRef.current = trackTurn;
  const pointDictationHere = useCallback(() => {
    setDictationTarget({
      kind: "assistant",
      agent,
      onTurn: (words, delivery) => {
        trackTurnRef.current(words, [], delivery, (error) => {
          setFailure(error instanceof Error && error.message !== "" ? error.message : `Couldn't reach ${title}.`);
        });
      },
    });
  }, [agent, title]);
  useFocusEffect(useCallback(() => {
    pointDictationHere();
    return () => {
      resetDictationTarget();
    };
  }, [pointDictationHere]));
  // A hold mounts the edge glow until it has faded; a tap that dictates into the field never shows it.
  const walkieOrb = useWalkieOrb();

  // A widget's reply button or input in the thread answers as a chip does: Isaac's next turn. One
  // callback for the thread's life, so the widgets below don't redraw on every keystroke.
  const sendTurnRef = useRef(sendTurn);
  sendTurnRef.current = sendTurn;
  const widgetReply = useCallback((words: string) => {
    sendTurnRef.current(words, [], false);
  }, []);

  // Image bytes are fetched against the omp session the thread runs in; empty while the agent is not running.
  const sessionId = snapshot === null || snapshot.sessionId === "" ? null : snapshot.sessionId;

  // The session the thread runs in stays subscribed while the thread shows: that is how the host
  // hands this phone an `ask` (or a tool approval) the assistant is blocked on, as a card above
  // the composer, and replays it after a reconnect. A rolled-over session moves the subscription.
  useFocusEffect(
    useCallback(() => {
      if (!connected || sessionId === null) return;
      subscribeAgent(sessionId);
      return () => {
        unsubscribeAgent(sessionId);
      };
    }, [sessionId, connected]),
  );
  const { ask: pendingAsk, answer: answerAsk, cancel: cancelAsk } = usePendingAsk(sessionId ?? undefined);

  // Open asks (`snapshot.asks`): questions the assistant is still waiting on. An older host sends
  // none, so it gets no badges and never an `assistant.ask.resolve`. One closed here hides at once,
  // until the host's next snapshot drops it (or comes back if the host refused).
  const openAsks = snapshot?.asks;
  const [hiddenAsks, setHiddenAsks] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setHiddenAsks((current) => pruneHidden(current, openAsks));
  }, [openAsks]);
  const hideAsk = (id: string): void => {
    setHiddenAsks((current) => new Set(current).add(id));
  };
  /** Closes `ask` on the host (hidden here at once); `answer` is the text Isaac picked or typed, which a session ask's asker gets. */
  const resolveAsk = (ask: OpenAsk, how: "answered" | "dismissed", answer?: string): void => {
    hideAsk(ask.id);
    sendCommand({ kind: "assistant.ask.resolve", agent, id: ask.id, how, ...(answer === undefined ? {} : { answer }) }).catch((error: unknown) => {
      warn("assistant.ask.resolve failed", error);
      setHiddenAsks((current) => new Set([...current].filter((id) => id !== ask.id)));
    });
  };
  /** The row Show in chat last scrolled to: it rings anew each time `n` grows, so the same ask shown again rings again. */
  const [rung, setRung] = useState({ id: "", n: 0 });
  const ringTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(ringTimer.current);
    },
    [],
  );
  const pendingApproval = useAgentsStore((state) => (sessionId === null ? undefined : state.approvals[sessionId]));
  // What runs for this thread now (helpers, sessions, harnesses, rooms, and its own sessions only while they work): chips under the header row.
  const activityItems = useActivityStore((state) => state.items);
  const sessions = useAgentsStore((state) => state.sessions);
  const owned = useMemo(() => ownedBy(sessions, agent), [sessions, agent]);
  const running = useMemo(() => runningChips(activityItems, artifactsThread, { threadSession: sessionId, sessions }, owned), [activityItems, artifactsThread, sessionId, sessions, owned]);
  // The model and thinking level of the thread's session, for the composer's chip.
  const threadSession = sessionId === null ? undefined : sessions[sessionId];
  const threadOptions = useAgentsStore((state) => (sessionId === null ? undefined : state.options[sessionId]));
  useEffect(() => {
    if (connected && sessionId !== null) requestAgentOptions(sessionId);
  }, [connected, sessionId]);

  // Background messages (the host's job lines arrive as `status` rows) show as quiet rows, and so do a guest's joined/left lines from a host that sends guests; any other status row is machinery, never shown.
  // Memoized: the bookmarks index these rows, and a keystroke in the composer must not rebuild them.
  const pendingRow = useMemo<AssistantMessage[]>(() => (pending === null ? [] : [{ id: PENDING_ID, role: "user", text: pending.text, at: Date.now() }]), [pending]);
  const guests = useAssistantStore((state) => state.guests);
  const messages = useMemo(
    () => (snapshot?.messages ?? []).filter((message) => message.role !== "status" || backgroundOf(message) !== null || guestRowKind(message, guests) !== null),
    [snapshot, guests],
  );
  // What the host's transcript (plus the echo of a turn in flight) says; local rows come after it and never count as its newest reply.
  const settled = useMemo(() => [...messages, ...pendingRow], [messages, pendingRow]);
  const newestSettled = settled[settled.length - 1];
  // Tap-to-answer replies under the newest reply once it has settled; hidden while offline, where a tap could not send.
  const replies = connected ? liveReplies(snapshot, pending) : null;
  // Open questions, minus the one whose ask card shows above the composer: the header button's count and its sheet.
  const shownAsks = useMemo(
    () => visibleAsks(openAsks, pendingAsk === undefined || sessionId === null ? null : { sessionId, askId: pendingAsk.id }, hiddenAsks),
    [openAsks, pendingAsk, sessionId, hiddenAsks],
  );
  // The last question answered or dismissed closes the sheet.
  useEffect(() => {
    if (shownAsks.length === 0) setAsksOpen(false);
  }, [shownAsks.length]);
  // An open ask with a bubble in the thread marks that bubble; one without (a session's, an `ask` card left open) is a card where it was asked.
  const messageIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
  const waitingIds = useMemo(() => waitingMessageIds(openAsks, hiddenAsks, messageIds), [openAsks, hiddenAsks, messageIds]);
  const cards = useMemo(() => askCards(shownAsks, messageIds), [shownAsks, messageIds]);
  const cardByRow = useMemo(() => new Map(cards.map((ask) => [askRowId(ask), ask])), [cards]);
  const { rows, newestFirst } = useMemo(() => {
    const all = [...withAskRows(messages, cards), ...localRows, ...pendingRow];
    return { rows: all, newestFirst: [...all].reverse() };
  }, [messages, cards, localRows, pendingRow]);
  // What the list holds: the newest `drawn` rows. Nearing the oldest of them adds a page.
  const listed = useMemo(() => newestFirst.slice(0, drawn), [newestFirst, drawn]);
  const total = newestFirst.length;
  const loadOlder = useCallback(() => {
    setDrawn((count) => (count < total ? count + PAGE : count));
  }, [total]);
  // Show in chat for a row older than the list holds: the list takes it in first, then scrolls once it is there.
  const [jumpTo, setJumpTo] = useState<number | null>(null);
  useEffect(() => {
    if (jumpTo === null || jumpTo >= listed.length) return;
    setJumpTo(null);
    scrollToRow(jumpTo);
  }, [jumpTo, listed.length, scrollToRow]);
  // Turns of the host's rows, for bookmarks: flagged by an ask nobody answered and by reactions.
  const turnRows = useMemo(() => assistantTurnRows(rows, (message) => message.id === PENDING_ID || isLocalRow(message.id) || isAskRow(message.id), pendingAsk !== undefined), [rows, pendingAsk]);
  useTurnBookmarks({ turnRows, thread: artifactsThread });
  const enteringMessages = useMessageEntrances(rows, snapshot !== null);
  const busy = snapshot?.busy === true;
  // The dots stand in for a reply that has not started: while the host says the session is working
  // and the newest row is not an assistant message already showing words. Once text streams, it is the indicator.
  const newest = newestFirst[0];
  const typing = busy && !(newestSettled?.role === "assistant" && newestSettled.text.trim() !== "");

  // Only the newest message Isaac typed carries a receipt: Sending while its echo is pending, Seen once
  // the host's snapshot lists it.
  const latestUserId = newestFirst.find((message) => message.role === "user" && backgroundOf(message) === null)?.id ?? null;
  const receipt = latestUserId === null ? null : latestUserId === PENDING_ID ? "Sending" : "Seen";

  const dark = useScheme() === "dark";
  const bg = dark ? BG_DARK : colors.bg;
  const listTop = headerHeight + HEADER_GAP;

  const onStackLayout = (event: LayoutChangeEvent): void => {
    const height = event.nativeEvent.layout.height;
    setStackHeight(height);
    stack.value = height;
  };

  /** The avatar menu: a native action sheet, since a bottom-sheet modal did not present on this screen. */
  const openMenu = (): void => {
    Keyboard.dismiss();
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: ["Edit avatar", "Edit instructions", `${title}'s computer`, "Mac live view", "Agent Inbox", "Cancel"], cancelButtonIndex: 5 },
      (index) => {
        if (index === 0) useLocalRowsStore.getState().openAvatarEditor(agent, portrait);
        // The phone has no Files tab: the assistant takes the change as a chat turn.
        if (index === 1) sendTurn("I'd like to change your instructions", [], false);
        if (index === 2) router.push("/eva-computer");
        if (index === 3) router.push("/screen");
        if (index === 4) router.push("/agents");
      },
    );
  };

  /** The attach menu, native too: the camera or the photo library. */
  const openAttach = (): void => {
    Keyboard.dismiss();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: full ? `Up to ${String(MAX_REPLY_IMAGES)} images` : "Attach",
        options: ["Camera", "Photo library", "Cancel"],
        cancelButtonIndex: 2,
        disabledButtonIndices: full ? [0, 1] : [],
      },
      (index) => {
        if (index === 0) attach("camera");
        if (index === 1) attach("library");
      },
    );
  };

  /** The composer's voice-call button: a live call, or the legacy call when GPT-Live is unavailable. */
  const call = (): void => {
    Keyboard.dismiss();
    setFailure(null);
    startVoiceCall(agent).catch((error: unknown) => {
      setFailure(error instanceof Error && error.message !== "" ? error.message : `Couldn't call ${title}.`);
    });
  };

  /** The thinking levels the thread session's model takes (empty: unknown model or an older host). */
  const thinkingLevels = threadOptions?.models.find((model) => model.name === threadSession?.model)?.thinkingLevels ?? [];
  // "Claude Opus 5.5" reads "Opus 5.5": the chip has little room, and the header already names the assistant.
  const modelName = threadSession?.model?.replace(/^Claude\s+/i, "");
  /** The card's chip: the thinking-level popover over it, else (no levels to pick) the avatar menu. */
  const openThinking = (anchor: PopoverAnchor): void => {
    if (sessionId === null || thinkingLevels.length === 0) {
      openMenu();
      return;
    }
    setThinkingAnchor(anchor);
  };
  const setThinking = (level: string): void => {
    if (sessionId === null) return;
    sendCommand({ kind: "agent.configure", sessionId, thinkingLevel: level }).catch((error: unknown) => {
      setFailure(error instanceof Error && error.message !== "" ? error.message : "Couldn't change the thinking level.");
    });
  };
  const chip = {
    label: modelName ?? title,
    detail: threadSession?.thinkingLevel === undefined ? undefined : capitalized(threadSession.thinkingLevel),
    onPress: openThinking,
  };

  /**
   * Show in chat (the questions sheet): the chat scrolls to the bubble that asked it (or its inline
   * card), centred, and the row rings (`WaitingMark`).
   */
  const jumpToAsk = (ask: OpenAsk): void => {
    Keyboard.dismiss();
    const target = askRowTarget(ask, messageIds);
    const index = newestFirst.findIndex((row) => row.id === target);
    if (index < 0) return;
    if (index < listed.length) scrollToRow(index);
    else {
      setDrawn(index + PAGE);
      setJumpTo(index);
    }
    // Ring once the scroll has settled; the row is on screen by then even when the list had to lay it out first.
    clearTimeout(ringTimer.current);
    ringTimer.current = setTimeout(() => {
      setRung((current) => ({ id: target, n: current.n + 1 }));
    }, RING_DELAY_MS);
  };

  /**
   * An answer to an open ask, from an inline card or the questions sheet: a thread ask goes out as
   * Isaac's turn too (tagged with its question unless its row is the newest); a session ask's
   * answer only to the host, which hands it to the asking session.
   */
  const answerOpenAsk = (ask: OpenAsk, reply: string): void => {
    if (ask.source !== "session") {
      const target = askRowTarget(ask, messageIds);
      sendTurn(answerText(reply, ask.question, target !== newestSettled?.id && target !== newestFirst[0]?.id), [], false);
    }
    resolveAsk(ask, "answered", reply.slice(0, MAX_ASK_ANSWER));
  };

  /** Sign-in card tapped: Eva's browser as a sheet, already on the login page, with `Password` for the form. */
  const openSignIn = useCallback(
    (messageId: string, signin: NonNullable<AssistantMessage["signin"]>): void => {
      Keyboard.dismiss();
      router.push({ pathname: "/eva-computer", params: { agent, messageId, url: signin.url, host: signin.host } });
    },
    [agent, router],
  );

  /** A reply chip under a bubble: the chips' row is an open ask too, answered, so its badge goes with it. An older bubble's answer carries its question. */
  const replyToRow = (message: AssistantMessage, reply: string): void => {
    const ask = openAsks?.find((entry) => entry.messageId === message.id);
    sendTurn(ask === undefined ? reply : answerText(reply, ask.question, message !== newestSettled), [], false);
    if (ask !== undefined) resolveAsk(ask, "answered", reply);
  };
  // The rows get callbacks that never change (each reads the screen's latest state), so a memoized row
  // redraws only when its own message or marks change, not on every snapshot or keystroke.
  const replyToRowRef = useRef(replyToRow);
  replyToRowRef.current = replyToRow;
  const onRowReply = useCallback((message: AssistantMessage, reply: string) => {
    replyToRowRef.current(message, reply);
  }, []);
  const onOpenImages = useCallback((uris: string[], start: number) => {
    setViewing({ uris, start });
  }, []);

  /** Reply from a bubble's menu: its text quoted above the cursor's line, then the composer focused there. */
  const replyWith = (quoted: string): void => {
    const next = quoteIntoDraft(draft, cursor.current, quoted);
    setDraft(next.draft);
    cursor.current = next.cursor;
    requestAnimationFrame(() => {
      expectKeyboard();
      composer.current?.focus();
      composer.current?.setSelection(next.cursor, next.cursor);
    });
  };

  const screen = (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]} edges={["bottom"]}>
      <View style={styles.fill}>
        {/* The list rides on the keyboard with the composer (a transform, so it never re-lays out while the keyboard moves). */}
        <Animated.View style={[styles.fill, listLiftStyle]}>
          {rows.length === 0 ? (
            <Animated.View style={[styles.fill, { paddingTop: listTop }, emptyStyle]}>
              <EmptyState
                symbol="bubble.left.and.text.bubble.right"
                title={`Say hi to ${title}`}
                body={connected || snapshot !== null ? "She lives on your Mac and keeps this one conversation going, day and night." : "Connect to your host to load the conversation."}
              />
            </Animated.View>
          ) : (
            // Reply buttons and inputs in the thread's widgets answer as Isaac's turn; offline they stay disabled.
            <ReplyWidgetActions reply={connected ? widgetReply : null}>
              <FlatList
                ref={listRef}
                style={styles.fill}
                data={listed}
                inverted
                keyExtractor={(message) => message.id}
                extraData={`${latestUserId ?? ""}|${receipt ?? ""}|${String(connected)}|${rung.id}:${String(rung.n)}|${[...waitingIds].join(",")}`}
                renderItem={({ item, index }) => {
                  const card = cardByRow.get(item.id);
                  return (
                    // Inverted: the next index is the older row above this one, and a row's top margin is the space above it.
                    <MessageAppearance animate={enteringMessages.has(item.id)} user={senderOf(item) === "user"} gap={gapAbove(item, newestFirst[index + 1])}>
                      {card !== undefined ? (
                        <AskInlineCard
                          ask={card}
                          source={card.from ?? title}
                          fill={dark ? BUBBLE_DARK : colors.surface}
                          page={bg}
                          pulse={rung.id === item.id ? rung.n : 0}
                          onPick={
                            connected
                              ? (reply) => {
                                  answerOpenAsk(card, reply);
                                }
                              : null
                          }
                        />
                      ) : (
                        <LocalRowFrame agent={agent} id={item.id}>
                          <Row
                            agent={agent}
                            message={item}
                            receipt={item.id === latestUserId ? receipt : null}
                            streaming={busy && item === newestSettled && item.role === "assistant"}
                            sessionId={sessionId}
                            local={item.id === PENDING_ID ? pending?.images : undefined}
                            replies={item === newestSettled ? replies : connected ? (openAsks?.find((entry) => entry.messageId === item.id && waitingIds.has(item.id))?.replies ?? null) : null}
                            waiting={waitingIds.has(item.id)}
                            pulse={rung.id === item.id ? rung.n : 0}
                            onReply={onRowReply}
                            onOpenImages={onOpenImages}
                            onSignIn={openSignIn}
                          />
                        </LocalRowFrame>
                      )}
                    </MessageAppearance>
                  );
                }}
                // Inverted: the header sits at the visual bottom, below the newest row; under it, room for the floating composer
                // that grows with the card on the UI thread, so the newest message stays just above the pill.
                ListHeaderComponent={
                  <>
                    {typing && <TypingRow title={title} gap={newest !== undefined && senderOf(newest) === "eva" ? GAP_RUN : GAP_SENDER} />}
                    <Animated.View style={reserveStyle} />
                  </>
                }
                // Inverted: room at the visual top for the frosted header, and for the keyboard's lift while it is up.
                contentContainerStyle={{ paddingBottom: listTop + keyboardRoom }}
                scrollIndicatorInsets={{ top: headerHeight + keyboardRoom, bottom: stackHeight + COMPOSER_PILL_HEIGHT + COMPOSER_BOTTOM }}
                contentOffset={{ x: 0, y: initialOffset.current }}
                onEndReached={loadOlder}
                onEndReachedThreshold={1}
                initialNumToRender={10}
                maxToRenderPerBatch={6}
                windowSize={WINDOW_SCREENS}
                {...scrollHandlers}
                // On drag, not interactive: the composer rides the keyboard's whole moves, and a finger-driven dismiss is not one it can follow without a native keyboard module.
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
              />
            </ReplyWidgetActions>
          )}
          {/* Pinned to the composer's top edge as it grows and lifts. */}
          <Animated.View pointerEvents="box-none" style={[styles.overComposer, overComposerStyle]}>
            <ScrollToBottom visible={awayFromBottom} onPress={scrollToBottom} />
          </Animated.View>
        </Animated.View>
        <FrostedBar
          style={[styles.header, { paddingTop: insets.top }]}
          onLayout={(event) => {
            setHeaderHeight(event.nativeEvent.layout.height);
          }}
        >
          <View style={styles.headerRow}>
            <BackButton
              onPress={() => {
                // Opened from Assistants it goes back there; a notification tap into a cold app has nothing behind it.
                if (router.canGoBack()) router.back();
                else router.replace("/assistants");
              }}
            />
            <Pressable accessibilityRole="button" accessibilityLabel={`${title} menu`} onPress={openMenu} style={styles.identity}>
              <AvatarTitle name={title} portrait={portrait} motion={{ signals, paused: onCall }} />
            </Pressable>
            {shownAsks.length > 0 && (
              <OpenAsksButton
                count={shownAsks.length}
                size={HEADER_BUTTON}
                onPress={() => {
                  Keyboard.dismiss();
                  setAsksOpen(true);
                }}
              />
            )}
            <ArtifactsButton
              thread={artifactsThread}
              size={HEADER_BUTTON}
              onPress={() => {
                Keyboard.dismiss();
                setArtifactsOpen(true);
              }}
            />
          </View>
          {running.length > 0 && (
            <View style={styles.running}>
              <RunningChips
                chips={running}
                onOpenSession={(id) => {
                  router.push({ pathname: "/agents/[sessionId]", params: { sessionId: id } });
                }}
                onOpenWorking={() => {
                  Keyboard.dismiss();
                  setArtifactsTab("subagents");
                  setArtifactsOpen(true);
                }}
              />
            </View>
          )}
        </FrostedBar>
        {/* No Pinned row under the header on the phone (Isaac, 2026-11-05): pins stay in the thread's Artifacts and on
            the desktop rail; `@/pins/PinnedRow` is kept for when it comes back. */}
        {/* Floats over the list at the safe-area bottom and rides on the keyboard; the list pads itself by its height. */}
        <Animated.View pointerEvents="box-none" style={[styles.composer, composerLiftStyle]}>
          <View onLayout={onStackLayout}>
            {banner !== null && (
              <View style={[styles.banner, { backgroundColor: bg }]}>
                <Banner tone="danger" message={banner} />
              </View>
            )}
            {/* What the assistant is blocked on, answered here; sending a message instead cancels the ask (the host's bridge does). */}
            {sessionId !== null && pendingApproval !== undefined ? (
              <View style={styles.blocked}>
                <SessionApprovalCard sessionId={sessionId} approval={pendingApproval} />
              </View>
            ) : (
              pendingAsk !== undefined && (
                <View style={styles.blocked}>
                  <AskCard
                    key={pendingAsk.id}
                    ask={pendingAsk}
                    onSubmit={(results) => {
                      answerAsk(results);
                      // The host closes its open ask; keep the badge from flashing back until it does.
                      const ask = openAsks?.find((entry) => entry.askId === pendingAsk.id);
                      if (ask !== undefined) hideAsk(ask.id);
                    }}
                    onCancel={() => {
                      cancelAsk();
                      const ask = openAsks?.find((entry) => entry.askId === pendingAsk.id);
                      if (ask !== undefined) resolveAsk(ask, "dismissed");
                    }}
                  />
                </View>
              )
            )}
          </View>
          <View style={styles.pillRow}>
            <AssistantComposer
              title={title}
              connected={connected}
              draft={draft}
              setDraft={setDraft}
              photos={photos}
              setPhotos={setPhotos}
              inputRef={composer}
              cursor={cursor}
              composing={composing}
              onComposing={(focused) => {
                setComposing(focused);
                if (focused) followContent();
              }}
              onAttach={openAttach}
              onSend={(words, sent) => {
                if (connected) sendTurn(words, sent, true);
              }}
              onCall={call}
              chip={chip}
              onWalkie={walkieOrb.start}
              restoreTarget={pointDictationHere}
              height={pillHeight}
            />
          </View>
        </Animated.View>
      </View>
      <ImageViewer
        images={viewerImages}
        start={viewing?.start ?? 0}
        onClose={() => {
          setViewing(null);
        }}
      />
      {walkieOrb.shown && <ListeningOrb />}
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
          tab={artifactsTab}
          onClose={() => {
            setArtifactsOpen(false);
            setArtifactsTab(null);
          }}
        />
        <OpenAsksSheet
          open={asksOpen}
          asks={shownAsks}
          assistant={title}
          connected={connected}
          onAnswer={answerOpenAsk}
          onDismiss={(ask) => {
            resolveAsk(ask, "dismissed");
          }}
          onShow={(ask) => {
            setAsksOpen(false);
            setTimeout(() => {
              jumpToAsk(ask);
            }, SHEET_CLOSE_MS);
          }}
          onClose={() => {
            setAsksOpen(false);
          }}
        />
        {/* Last, over everything: it fills the screen (a tap outside closes it). */}
        <ThinkingPopover
          anchor={thinkingAnchor}
          model={modelName ?? title}
          levels={thinkingLevels}
          current={threadSession?.thinkingLevel}
          onSelect={setThinking}
          onClose={() => {
            setThinkingAnchor(null);
          }}
        />
      </View>
    </BubbleMenuProvider>
  );
}

/** Back chevron, a plain glyph on the frosted header. */
function BackButton({ onPress }: { onPress: () => void }) {
  return <IconButton symbol="chevron.left" size={HEADER_BUTTON} glyphSize={19} backgroundColor="transparent" onPress={onPress} accessibilityLabel="Back" />;
}

/** A row this screen added itself (the avatar editor) can close itself; host rows pass through. */
function LocalRowFrame({ agent, id, children }: { agent: string; id: string; children: ReactNode }) {
  if (!isLocalRow(id)) return <>{children}</>;
  return (
    <WidgetCloseProvider
      close={() => {
        useLocalRowsStore.getState().dismiss(agent, id);
      }}
    >
      {children}
    </WidgetCloseProvider>
  );
}

/** "medium" reads "Medium" in the chip and the thinking sheet. */
function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Space above a row: the sender gap when the row above (older) is by someone else, the run gap when it is by the same one. */
function gapAbove(message: AssistantMessage, above: AssistantMessage | undefined): number {
  if (above === undefined) return 0;
  return senderOf(message) === senderOf(above) ? GAP_RUN : GAP_SENDER;
}

/** Who a row reads as for spacing and entrance: a background message is a quiet system row, not Isaac's turn. */
function senderOf(message: AssistantMessage): "user" | "status" | "eva" {
  if (message.role === "status" || backgroundOf(message) !== null || message.guest?.kind === "join" || message.guest?.kind === "leave") return "status";
  return message.role === "user" ? "user" : "eva";
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
  /** Tap-to-answer replies to show under the bubble: the newest settled reply, and any older bubble with an open ask. */
  replies: readonly string[] | null;
  /** A reply chip under `message` was tapped: send its words as Isaac's turn. */
  onReply: (message: AssistantMessage, reply: string) => void;
  /** An open ask sits on this bubble: it keeps its accent edge and "Waiting on you" tag. */
  waiting: boolean;
  /** Rings the bubble when it grows (`WaitingMark`); 0 until a badge was tapped. */
  pulse: number;
}

function RowView({ agent, message, receipt, streaming, sessionId, local, onOpenImages, onSignIn, replies, onReply, waiting, pulse }: RowProps) {
  const signedIn = useAssistantStore((state) => threadOf(state, agent).signedIn[message.id] === true);
  const guests = useAssistantStore((state) => state.guests);
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
  // Another assistant in the thread (a host that sends guests): its joined/left line, its bubble or its work card.
  const guestKind = guestRowKind(message, guests);
  if (guestKind !== null && message.guest !== undefined) {
    if (guestKind === "line") return <GuestLine entry={message.guest} />;
    if (guestKind === "say") return <GuestBubble entry={message.guest} />;
    return <WorkCardRow entry={message.guest} />;
  }
  // A turn Isaac did not type (a job line, heartbeat, canvas notice, handoff, tapback): a quiet centered row.
  const background = backgroundOf(message);
  if (background !== null) return <BackgroundRow message={background} at={message.at} fill={bubbleFill} />;
  switch (message.role) {
    case "user": {
      // A direct image link Isaac typed shows as a picture above the bubble, like an attached photo.
      const linked = userImageUrls(stripAnswerContext(message.text));
      const bubbleText = linked.rest;
      const showText = bubbleText !== "" || (imageCount === 0 && linked.urls.length === 0);
      return (
        <View style={styles.userRow}>
          {images("flex-end")}
          {linked.urls.length > 0 && (
            <View style={hasText ? styles.imagesAbove : undefined}>
              <MarkdownImages images={linked.urls.map((src) => ({ src, alt: "" }))} />
            </View>
          )}
          {showText && (
            <ChatBubble
              messageKey={reactionKey}
              side="right"
              text={bubbleText}
              style={styles.userBubbleFrame}
              radius={USER_RADIUS}
              ring={page}
              accessibilityLabel={message.text}
            >
              <View style={[styles.userBubble, { backgroundColor: colors.bubbleUser }]}>
                <Text style={styles.userText}>{bubbleText}</Text>
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
    }
    case "assistant": {
      // Markdown images Eva embeds stack above the bubble as tiles, as Dot's do; the prose keeps its bubble.
      // A `[[room:<id>]]` line (an assistant set up a room) is a room card under it.
      const roomed = splitRoomCards(message.text, streaming);
      const text = roomed.text;
      const { images: tiles, hasBody } = topLevelImages(text);
      const { signin } = message;
      const showBubble = hasBody || (imageCount === 0 && tiles.length === 0 && signin === undefined && roomed.rooms.length === 0);
      // A reply with widgets breaks out to the row's full width: its prose stays in texting bubbles,
      // each widget sits in a card of its own between them. One reaction target for the whole reply.
      const segments = hasBody ? bubbleSegments(text) : [];
      const wide = segments.some((segment) => segment.kind === "widget");
      // The whole row reports its media's failures, tiles above the bubble included (`RenderMessage`).
      return (
        <RenderMessage thread={assistantReactionThread(agent)} message={reactionKey}>
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
              <ChatBubble messageKey={reactionKey} side="left" text={text} style={wide ? styles.evaWideFrame : styles.evaBubbleFrame} radius={EVA_RADIUS} ring={page}>
                {wide ? (
                  <View style={styles.segments}>
                    {segments.map((segment, i) =>
                      segment.kind === "widget" ? (
                        <View key={i} style={[styles.widgetCard, { backgroundColor: bubbleFill }]} testID="eva-widget-card">
                          <MessageText text={segment.text} large streaming={streaming} />
                        </View>
                      ) : topLevelImages(segment.text).hasBody ? (
                        <View key={i} style={[styles.evaBubble, styles.segmentBubble, { backgroundColor: bubbleFill }]}>
                          <MessageText text={segment.text} large skipImages streaming={streaming} />
                        </View>
                      ) : null,
                    )}
                  </View>
                ) : (
                  <View style={[styles.evaBubble, { backgroundColor: bubbleFill }]}>
                    <MessageText text={text} large skipImages streaming={streaming} />
                  </View>
                )}
                {waiting && <WaitingMark radius={EVA_RADIUS} pulse={pulse} page={page} />}
              </ChatBubble>
            )}
            {roomed.rooms.map((r) => (
              <RoomCardRow key={r.id} refRoom={r} />
            ))}
            {replies !== null && (
              <View style={styles.replies}>
                <ReplyChips
                  replies={replies}
                  onPick={(reply) => {
                    onReply(message, reply);
                  }}
                />
              </View>
            )}
          </View>
        </RenderMessage>
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

/** A snapshot redraws only the rows whose message or marks changed: unchanged messages keep their objects (`sharedSnapshot`) and the callbacks never change. */
const Row = memo(RowView);

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  /** Floats over the list's top; the list pads itself by its measured height. */
  header: { position: "absolute", top: 0, left: 0, right: 0 },
  headerRow: { height: HEADER_ROW, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.sm, gap: spacing.xs },
  /** The identity takes the room the buttons leave. */
  identity: { flex: 1, minWidth: 0, paddingHorizontal: spacing.xs },
  running: { paddingBottom: spacing.xs + 2 },
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
  /** A reply with widgets: the row's full width, prose bubbles hugging the left at the usual measure. */
  evaWideFrame: { alignSelf: "stretch" },
  segments: { gap: GAP_RUN },
  segmentBubble: { alignSelf: "flex-start", maxWidth: "88%" },
  /** Padding of radii.md's difference from the bubble's, so the widget's own frame sits concentric in the card. */
  widgetCard: { borderRadius: EVA_RADIUS, padding: EVA_RADIUS - radii.md },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  status: { textAlign: "center", paddingHorizontal: spacing.xxxl, fontWeight: "400" },
  /** At the safe-area bottom, over the list (the list reserves its height); lifted by the keyboard as a transform. */
  composer: { position: "absolute", left: 0, right: 0, bottom: 0, paddingBottom: COMPOSER_BOTTOM },
  /** A zero-height line at the list's bottom, moved up to the composer's top edge: the scroll-to-bottom button sits on it. */
  overComposer: { position: "absolute", left: 0, right: 0, bottom: 0, height: 0 },
  banner: { paddingBottom: spacing.sm },
  /** The ask or approval card the assistant is blocked on, above the pill, as wide as the pill. */
  blocked: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  pillRow: { paddingHorizontal: spacing.lg },
  menuTitle: { textAlign: "center", paddingBottom: spacing.md },
  menuRows: { marginHorizontal: -spacing.xl },
  imagesAbove: { marginBottom: spacing.xs },
  signinAbove: { marginBottom: spacing.sm },
  /** Clear of the reaction badges that overlap the bubble's bottom corner. */
  replies: { marginTop: spacing.sm },
});
