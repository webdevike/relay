import { useMemo, useEffect, useRef, useState } from "react";
import { FlatList, Image, Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { accountLabel, untagged, type AgentImageRef, type AgentMessage, type AgentSession, type AgentStatus } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Pill, type PillProps } from "@/ui/Pill";
import { spacing, useColors, type Colors } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { requestAgentImage } from "@/connection";
import { loadSkia } from "@/dictation/skia";
import { userBubble } from "@/lib/slash";
import type { SentCommand } from "@/lib/sentCommand";
import { echoRows, type UserEcho } from "@/lib/userEcho";
import { ImageViewer } from "./ImageViewer";
import { modelShortName, VendorLogo } from "./VendorLogo";
import { MessageText } from "./MessageText";
import { ChatBubble } from "./BubbleMenu";
import { bubbleReactionKey } from "@/lib/reactions";
import { ActivityRow } from "./ActivityRow";
import { ToolRow } from "./ToolRow";
import { ToolStack, ToolTimelineSheet } from "./ToolStack";
import { MessageAppearance } from "@/ui/MessageAppearance";
import { ScrollToBottom } from "@/ui/ScrollToBottom";
import { useInvertedChatScroll } from "@/ui/useInvertedChatScroll";
import { useMessageEntrances } from "@/ui/useMessageEntrances";
import { GrowIn } from "@/ui/GrowIn";
/**
 * Where each session's transcript was left, as the inverted list's offset (0 = the newest message
 * in view). A card mounts straight at that offset, so switching sessions never scrolls.
 */
const scrollMemory = new Map<string, number>();
/** Thumbnails never exceed this box; a ref without dimensions gets a square of `THUMB_SQUARE`. */
const THUMB_MAX_HEIGHT = 160;
const THUMB_MAX_WIDTH = 240;
const THUMB_SQUARE = 120;
const THUMB_RADIUS = 12;

const pillFor: Record<AgentStatus, { label: string; tone: NonNullable<PillProps["tone"]> }> = {
  working: { label: "Working", tone: "accent" },
  waiting: { label: "Waiting for you", tone: "warn" },
  needs_permission: { label: "Needs permission", tone: "warn" },
  idle: { label: "Idle", tone: "textMuted" },
  ended: { label: "Ended", tone: "textMuted" },
};

function thumbnailSize(ref: AgentImageRef): { width: number; height: number } {
  if (ref.width === undefined || ref.height === undefined) return { width: THUMB_SQUARE, height: THUMB_SQUARE };
  const scale = Math.min(THUMB_MAX_HEIGHT / ref.height, THUMB_MAX_WIDTH / ref.width, 1);
  return { width: Math.round(ref.width * scale), height: Math.round(ref.height * scale) };
}

interface MessageImagesProps {
  sessionId: string;
  refs: AgentImageRef[];
  onOpen: (uri: string) => void;
}

/**
 * One message's attachments. Bytes are fetched on first sight (once per ref, see
 * `requestAgentImage`); until they land a raised placeholder holds the thumbnail's spot, and a
 * `null` answer (the host no longer has the image) shows a photo glyph instead.
 */
function MessageImages({ sessionId, refs, onOpen }: MessageImagesProps) {
  const colors = useColors();
  const images = useAgentsStore((state) => state.images[sessionId]);
  useEffect(() => {
    for (const ref of refs) {
      if (images?.[ref.id] === undefined) requestAgentImage(sessionId, ref.id);
    }
  }, [sessionId, refs, images]);

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {refs.map((ref, index) => {
        // Ref ids are content hashes, so the same picture attached twice repeats an id; the
        // list is fixed per message, so position keeps keys unique.
        const key = `${index}:${ref.id}`;
        const uri = images?.[ref.id];
        const size = thumbnailSize(ref);
        const frame = { ...size, borderRadius: THUMB_RADIUS, borderWidth: 1, borderColor: colors.hairline, overflow: "hidden" as const };
        if (typeof uri !== "string") {
          return (
            <View key={key} style={[frame, { backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" }]}>
              {uri === null && <SymbolView name="photo" size={28} tintColor={colors.textFaint} />}
            </View>
          );
        }
        return (
          <Pressable
            key={key}
            onPress={() => {
              onOpen(uri);
            }}
            style={({ pressed }) => [frame, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Image source={{ uri }} resizeMode="cover" style={size} />
          </Pressable>
        );
      })}
    </View>
  );
}

interface MessageRowProps {
  sessionId: string;
  message: AgentMessage;
  onOpenImage: (uri: string) => void;
  /** Why the host refused this (phone-side) message; shown under its bubble. */
  error?: string | undefined;
  /** The phone's own stand-in for words the transcript does not list yet: it takes no reaction. */
  pending: boolean;
}

const USER_RADIUS = 24;
/** The card a lifted reply (plain text, no bubble) sits on in the reaction overlay. */
const REPLY_LIFT_RADIUS = 18;
const REPLY_LIFT_INSET = 10;

function MessageRow({ sessionId, message, onOpenImage, error, pending }: MessageRowProps) {
  const colors = useColors();
  const reactionKey = bubbleReactionKey(message, pending);
  const images =
    message.images === undefined || message.images.length === 0 ? null : <MessageImages sessionId={sessionId} refs={message.images} onOpen={onOpenImage} />;
  switch (message.role) {
    case "user": {
      // A slash command reads as one: the command in a chip, whatever followed it under.
      const { command, rest } = userBubble(message.text);
      return (
        <View style={{ alignItems: "flex-end", paddingHorizontal: spacing.xl, gap: spacing.xs }}>
          <ChatBubble
            messageKey={reactionKey}
            side="right"
            text={message.text}
            style={{ maxWidth: "85%" }}
            radius={USER_RADIUS}
            // The bubble's tint is see-through: lifted over the blur it keeps the chat's surface under it.
            card={{ fill: colors.surface, radius: USER_RADIUS, inset: 0 }}
            ring={colors.surface}
          >
            <View
              style={{
                // The accent at 0.16 opacity.
                backgroundColor: `${colors.accent}29`,
                borderWidth: 1,
                borderColor: error === undefined ? colors.hairline : colors.danger,
                borderRadius: USER_RADIUS,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                gap: spacing.sm,
              }}
            >
              {command !== undefined && <Pill label={command} tone="accent" />}
              {rest.length > 0 && <MessageText text={rest} large />}
              {images}
            </View>
          </ChatBubble>
          {error !== undefined && (
            <Text variant="caption" color="danger" style={{ maxWidth: "85%", textAlign: "right" }}>
              {`Not sent: ${error}`}
            </Text>
          )}
        </View>
      );
    }
    case "assistant":
      return (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <ChatBubble
            messageKey={reactionKey}
            side="left"
            text={message.text}
            radius={0}
            card={{ fill: colors.surface, radius: REPLY_LIFT_RADIUS, inset: REPLY_LIFT_INSET }}
            ring={colors.surface}
          >
            <View style={{ gap: spacing.sm }}>
              {message.text.length > 0 && <MessageText text={message.text} large streaming={message.streaming === true} />}
              {images}
            </View>
          </ChatBubble>
        </View>
      );
    case "tool":
      return (
        <View style={{ gap: spacing.sm }}>
          {message.tool === undefined ? (
            <Text variant="caption" color="textMuted" numberOfLines={1} style={{ paddingHorizontal: spacing.xl }}>
              {message.text}
            </Text>
          ) : (
            <ToolRow name={message.tool.name} summary={message.tool.summary} />
          )}
          {images !== null && <View style={{ paddingHorizontal: spacing.xl }}>{images}</View>}
        </View>
      );
    case "system":
      return (
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.sm }}>
          <Text variant="caption" color="textMuted">
            {message.text}
          </Text>
          {images}
        </View>
      );
  }
}

export function CardPlaceholder({ text }: { text: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxxl }}>
      <Text variant="body" color="textMuted" style={{ textAlign: "center" }}>
        {text}
      </Text>
    </View>
  );
}

export interface AgentHeaderProps {
  session: AgentSession;
}

/** The session's title, status, account, and model: the inbox's top card. */
export function AgentHeader({ session }: AgentHeaderProps) {
  const pill = pillFor[session.status];
  return (
    <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.lg, gap: spacing.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md }}>
        <Text variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
          {session.title}
        </Text>
        <Pill label={pill.label} tone={pill.tone} />
      </View>
      {session.statusDetail !== undefined && (
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {session.statusDetail}
        </Text>
      )}
      {session.account !== undefined && (
        <Text variant="caption" color="textFaint" numberOfLines={1} testID="agent-account">
          {accountLabel(session.account)}
        </Text>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
        {session.model !== undefined ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 }}>
            {session.modelVendor !== undefined && <VendorLogo vendor={session.modelVendor} size={13} />}
            <Text variant="caption" color="textFaint" numberOfLines={1} style={{ flexShrink: 1 }}>
              {modelShortName(session.model, session.modelVendor)}
              {session.thinkingLevel === undefined ? "" : ` · ${session.thinkingLevel}`}
            </Text>
          </View>
        ) : (
          <View />
        )}
        {session.contextUsed !== undefined && <ContextRing used={session.contextUsed} />}
      </View>
    </View>
  );
}

const RING_SIZE = 14;
const RING_STROKE = 2;

/** Green while there is room, yellow as the window fills, red when compaction is close. */
function contextColor(colors: Colors, used: number): string {
  if (used <= 0.4) return colors.ok;
  if (used <= 0.65) return colors.warn;
  return colors.danger;
}

/** A small ring, under the status, filling clockwise with the share of the context window in use. */
function ContextRing({ used }: { used: number }) {
  const colors = useColors();
  const sk = loadSkia();
  const color = contextColor(colors, used);
  if (sk === null) {
    return <View style={{ width: RING_SIZE, height: RING_SIZE, borderRadius: RING_SIZE / 2, borderWidth: RING_STROKE, borderColor: color }} />;
  }
  const { Canvas, Path, Skia } = sk;
  const inset = RING_STROKE / 2;
  const rect = Skia.XYWHRect(inset, inset, RING_SIZE - RING_STROKE, RING_SIZE - RING_STROKE);
  const track = Skia.Path.Make();
  track.addOval(rect);
  const arc = Skia.Path.Make();
  arc.addArc(rect, -90, Math.max(0.5, used * 360));
  return (
    <Canvas style={{ width: RING_SIZE, height: RING_SIZE }}>
      <Path path={track} color={colors.hairline} style="stroke" strokeWidth={RING_STROKE} />
      <Path path={arc} color={color} style="stroke" strokeWidth={RING_STROKE} strokeCap="round" />
    </Canvas>
  );
}

export interface AgentCardProps {
  /** The session `messages` belong to; image bytes are fetched against it. */
  sessionId: string | undefined;
  messages: AgentMessage[] | undefined;
  connected: boolean;
  /** The session's live status; `working` shows the activity row (held briefly after it stops). */
  status?: AgentStatus | undefined;
  /** The tool the host says is running, for the activity row when the newest row does not say more. */
  activity?: string | undefined;
  /** Replaces the activity row's text outright (e.g. "Starting omp" for a session not yet open). */
  activityLabel?: string | undefined;
  /**
   * A slash command the phone sent that the session has not answered yet: shown as the newest row
   * (EvaOS's sent row), with "Running /name" in the activity row; a `/handoff` leaves the activity
   * to the handoff banner.
   */
  sent?: SentCommand | undefined;
  /**
   * Words sent from this phone that the transcript does not carry yet (lib/userEcho.ts), drawn as
   * the newest user bubbles, even before the conversation has loaded; a refused one is marked.
   */
  echoes?: readonly UserEcho[] | undefined;
}

/**
 * One session's transcript. The list is inverted (newest message at offset 0), so a fresh card
 * shows the end without a single scroll, a session comes back at the offset it was left at, and
 * a new message only pulls the view when the reader was already near the newest.
 */
export function AgentCard({ sessionId, messages, connected, status, activity, activityLabel, sent, echoes }: AgentCardProps) {
  const [viewing, setViewing] = useState<string | null>(null);
  const viewingImages = useMemo(() => (viewing === null ? null : [{ uri: viewing }]), [viewing]);
  const [timeline, setTimeline] = useState<string | null>(null);
  const rows = useMemo(() => {
    if (echoes === undefined || echoes.length === 0) return messages;
    return [...(messages ?? []), ...echoRows(echoes)];
  }, [messages, echoes]);
  const refused = useMemo(() => {
    const reasons: Record<string, string> = {};
    for (const echo of echoes ?? []) if (echo.error !== undefined) reasons[echo.id] = echo.error;
    return reasons;
  }, [echoes]);
  const echoIds = useMemo(() => new Set(echoes?.map((echo) => echo.id)), [echoes]);
  // The words last drawn as echoes: the transcript row that takes one over is already on screen,
  // so it does not make its entrance again.
  const echoTexts = useRef<ReadonlySet<string>>(new Set());
  const retired = echoTexts.current;
  useEffect(() => {
    echoTexts.current = new Set(echoes?.map((echo) => echo.text));
  }, [echoes]);
  const newestFirst = useMemo(() => {
    if (rows === undefined) return undefined;
    const reversed = [...rows].reverse();
    if (sent !== undefined) reversed.unshift({ id: `sent-${String(sent.at)}`, role: "user", text: sent.text, at: sent.at });
    return reversed;
  }, [rows, sent]);
  // Consecutive tool calls collapse into one row, keyed by the run's first call so it never remounts.
  const grouped = useMemo(() => {
    if (newestFirst === undefined) return undefined;
    const runs = new Map<string, AgentMessage[]>();
    const listed: AgentMessage[] = [];
    let run: AgentMessage[] | null = null;
    for (const message of [...newestFirst].reverse()) {
      if (message.role === "tool" && (message.images === undefined || message.images.length === 0)) {
        if (run === null) {
          run = [];
          runs.set(message.id, run);
          listed.push(message);
        }
        run.push(message);
      } else if (message.role === "assistant" && message.text.trim().length === 0 && (message.images === undefined || message.images.length === 0)) {
        // An empty assistant turn (a tool-only step, or a reply whose words have not come yet) draws
        // nothing, so it is no row: an empty row still took the list's spacing. Nor does it split the run.
        continue;
      } else {
        run = null;
        listed.push(message);
      }
    }
    return { listed: listed.reverse(), runs };
  }, [newestFirst]);
  const newest = messages === undefined ? undefined : messages[messages.length - 1];
  const running = sent !== undefined && !sent.handoff ? `Running ${sent.name}` : undefined;
  const working = status === "working" || running !== undefined;
  // Hold the activity row through the brief idle gaps between tool calls, so it does not blink out and back.
  const [showActivity, setShowActivity] = useState(working);
  useEffect(() => {
    if (working) { setShowActivity(true); return; }
    const timer = setTimeout(() => { setShowActivity(false); }, 600);
    return () => { clearTimeout(timer); };
  }, [working]);
  // Mounted from when it shows until its collapse ends, so it closes as smoothly as it opened.
  const [activityMounted, setActivityMounted] = useState(working);
  useEffect(() => {
    if (showActivity) setActivityMounted(true);
  }, [showActivity]);
  // The newest row says what is going on before the session's status catches up (the host sends a
  // call's row, then its status): the agent's words, streaming or just finished, are "Responding"
  // until a call or the next turn follows them, and a call is running from the moment its row lands.
  const responding = newest?.role === "assistant" && newest.text.length > 0;
  const tool = (newest?.role === "tool" ? newest.tool?.name : undefined) ?? activity;
  const liveLabel = activityLabel ?? running ?? (responding ? "Responding" : tool === undefined ? "Working" : `Running ${tool}`);
  // Through the hold after work stops, the row keeps its last words instead of falling back to "Working".
  const [heldLabel, setHeldLabel] = useState(liveLabel);
  useEffect(() => {
    if (working) setHeldLabel(liveLabel);
  }, [working, liveLabel]);
  const label = working ? liveLabel : heldLabel;
  // Read once per mount: returning to a session preserves both its position and follow mode.
  const initialOffset = useRef(sessionId === undefined ? 0 : (scrollMemory.get(sessionId) ?? 0));
  const { listRef, awayFromBottom, scrollToBottom, scrollHandlers } = useInvertedChatScroll<AgentMessage>({
    initialOffset: initialOffset.current,
    onOffset: (offset) => { if (sessionId !== undefined) scrollMemory.set(sessionId, offset); },
  });
  // Rows, not messages: an empty reply that gains its first words becomes a row then, and enters then.
  const enteringMessages = useMessageEntrances(grouped?.listed, grouped !== undefined);

  if (rows === undefined || sessionId === undefined) {
    return <CardPlaceholder text={connected ? "Loading conversation…" : "Connect to your host to load this conversation."} />;
  }
  if (newestFirst?.length === 0 && !showActivity) return <CardPlaceholder text="No messages yet." />;
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        data={grouped?.listed}
        extraData={grouped?.runs}
        inverted
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => (
          <GrowIn enabled={enteringMessages.has(item.id) && item.role !== "user"}>
            <MessageAppearance
              animate={
                enteringMessages.has(item.id) &&
                item.role === "user" && !retired.has(untagged(item.text).trim())
              }
              user={item.role === "user"}
              gap={spacing.sm}
            >
              {grouped?.runs.has(item.id) === true ? (
                <ToolStack calls={grouped.runs.get(item.id) ?? []} onOpen={() => { setTimeline(item.id); }} />
              ) : (
                <MessageRow
                  sessionId={sessionId}
                  message={item}
                  onOpenImage={setViewing}
                  error={refused[item.id]}
                  pending={echoIds.has(item.id) || (sent !== undefined && item.id === `sent-${String(sent.at)}`)}
                />
              )}
            </MessageAppearance>
          </GrowIn>
        )}
        // Inverted: paddingTop is the visual bottom. Each row carries the space above it (its `gap`, the
        // activity row's own padding), so that space opens with the row instead of appearing at once.
        contentContainerStyle={{ paddingTop: spacing.lg, paddingBottom: spacing.lg - spacing.sm }}
        ListHeaderComponent={
          activityMounted ? (
            <GrowIn enabled open={showActivity} onClosed={() => { setActivityMounted(false); }}>
              <ActivityRow label={label} />
            </GrowIn>
          ) : null
        }
        contentOffset={{ x: 0, y: initialOffset.current }}
        {...scrollHandlers}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      />
      <ScrollToBottom visible={awayFromBottom} onPress={scrollToBottom} bottom={spacing.lg} />
      <ImageViewer
        images={viewingImages}
        onClose={() => {
          setViewing(null);
        }}
      />
      {timeline !== null && (
        // Mounted on open with visible set, the pattern every working Sheet in the app uses.
        <ToolTimelineSheet calls={grouped?.runs.get(timeline) ?? []} onClose={() => { setTimeline(null); }} />
      )}
    </View>
  );
}
