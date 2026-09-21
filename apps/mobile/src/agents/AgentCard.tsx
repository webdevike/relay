import { useMemo, useEffect, useRef, useState } from "react";
import { FlatList, Image, Pressable, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SymbolView } from "expo-symbols";
import type { AgentImageRef, AgentMessage, AgentSession, AgentStatus } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Pill, type PillProps } from "@/ui/Pill";
import { colors, radii, spacing } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { requestAgentImage } from "@/connection";
import { loadSkia } from "@/dictation/skia";
import { ImageViewer } from "./ImageViewer";
import { modelShortName, VendorLogo } from "./VendorLogo";
import { MessageText } from "./MessageText";
import { ActivityRow } from "./ActivityRow";
/** Within this many points of the newest message, a new one keeps the list pinned to it. */
const BOTTOM_STICK_PX = 80;
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
}

function MessageRow({ sessionId, message, onOpenImage }: MessageRowProps) {
  const images =
    message.images === undefined || message.images.length === 0 ? null : <MessageImages sessionId={sessionId} refs={message.images} onOpen={onOpenImage} />;
  switch (message.role) {
    case "user":
      return (
        <View style={{ alignItems: "flex-end", paddingHorizontal: spacing.xl }}>
          <View
            style={{
              maxWidth: "85%",
              backgroundColor: "rgba(124,156,255,0.16)",
              borderRadius: radii.md,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              gap: spacing.sm,
            }}
          >
            {message.text.length > 0 && <MessageText text={message.text} />}
            {images}
          </View>
        </View>
      );
    case "assistant":
      return (
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.sm }}>
          {message.text.length > 0 && <MessageText text={message.text} />}
          {message.streaming === true && message.text.length > 0 && (
            <Text variant="caption" color="accent">
              ▍
            </Text>
          )}
          {images}
        </View>
      );
    case "tool":
      return (
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.sm }}>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {message.tool === undefined ? message.text : `${message.tool.name}: ${message.tool.summary}`}
          </Text>
          {images}
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

/** The session's title, status, and model: the inbox's top card. */
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
function contextColor(used: number): string {
  if (used <= 0.4) return colors.ok;
  if (used <= 0.65) return colors.warn;
  return colors.danger;
}

/** A small ring, under the status, filling clockwise with the share of the context window in use. */
function ContextRing({ used }: { used: number }) {
  const sk = loadSkia();
  const color = contextColor(used);
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
  /** The session's live status; `working` shows the activity row unless text is streaming in. */
  status?: AgentStatus | undefined;
  /** The tool the host says is running, for the activity row. */
  activity?: string | undefined;
  /** Replaces the activity row's text outright (e.g. "Starting omp" for a session not yet open). */
  activityLabel?: string | undefined;
}

/**
 * One session's transcript. The list is inverted (newest message at offset 0), so a fresh card
 * shows the end without a single scroll, a session comes back at the offset it was left at, and
 * a new message only pulls the view when it was already within `BOTTOM_STICK_PX` of the newest.
 */
export function AgentCard({ sessionId, messages, connected, status, activity, activityLabel }: AgentCardProps) {
  const [viewing, setViewing] = useState<string | null>(null);
  const newestFirst = useMemo(() => (messages === undefined ? undefined : [...messages].reverse()), [messages]);
  const newest = messages === undefined ? undefined : messages[messages.length - 1];
  const showActivity = status === "working" && !(newest?.streaming === true && newest.text.length > 0);
  const remember = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    if (sessionId !== undefined) scrollMemory.set(sessionId, Math.max(0, event.nativeEvent.contentOffset.y));
  };
  // Read once per mount: the prop only seeds the native scroll view's first position.
  const initialOffset = useRef(sessionId === undefined ? 0 : (scrollMemory.get(sessionId) ?? 0));

  if (messages === undefined || sessionId === undefined) {
    return <CardPlaceholder text={connected ? "Loading conversation…" : "Connect to your host to load this conversation."} />;
  }
  if (messages.length === 0 && !showActivity) return <CardPlaceholder text="No messages yet." />;
  return (
    <>
      <FlatList
        style={{ flex: 1 }}
        data={newestFirst}
        inverted
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => <MessageRow sessionId={sessionId} message={item} onOpenImage={setViewing} />}
        contentContainerStyle={{ paddingVertical: spacing.lg, gap: spacing.sm }}
        ListHeaderComponent={showActivity ? <ActivityRow label={activityLabel ?? (activity === undefined ? "Thinking" : `Running ${activity}`)} /> : null}
        contentOffset={{ x: 0, y: initialOffset.current }}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: BOTTOM_STICK_PX }}
        onScroll={remember}
        onScrollEndDrag={remember}
        onMomentumScrollEnd={remember}
        scrollEventThrottle={100}
      />
      <ImageViewer
        uri={viewing}
        onClose={() => {
          setViewing(null);
        }}
      />
    </>
  );
}
