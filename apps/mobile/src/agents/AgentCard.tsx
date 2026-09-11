import { useEffect, useRef, useState } from "react";
import { FlatList, Image, Pressable, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SymbolView } from "expo-symbols";
import type { AgentImageRef, AgentMessage, AgentSession, AgentStatus } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Pill, type PillProps } from "@/ui/Pill";
import { colors, radii, spacing } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { requestAgentImage } from "@/connection";
import { ImageViewer } from "./ImageViewer";
import { modelShortName, VendorLogo } from "./VendorLogo";
/** Within this many points of the end, new messages keep the list pinned to the bottom. */
const BOTTOM_STICK_PX = 80;
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
      {refs.map((ref) => {
        const uri = images?.[ref.id];
        const size = thumbnailSize(ref);
        const frame = { ...size, borderRadius: THUMB_RADIUS, borderWidth: 1, borderColor: colors.hairline, overflow: "hidden" as const };
        if (typeof uri !== "string") {
          return (
            <View key={ref.id} style={[frame, { backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" }]}>
              {uri === null && <SymbolView name="photo" size={28} tintColor={colors.textFaint} />}
            </View>
          );
        }
        return (
          <Pressable
            key={ref.id}
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
            {message.text.length > 0 && <Text variant="body">{message.text}</Text>}
            {images}
          </View>
        </View>
      );
    case "assistant":
      return (
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.sm }}>
          {message.text.length > 0 && <Text variant="body">{message.text}</Text>}
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
      {session.model !== undefined && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          {session.modelVendor !== undefined && <VendorLogo vendor={session.modelVendor} size={13} />}
          <Text variant="caption" color="textFaint" numberOfLines={1} style={{ flexShrink: 1 }}>
            {modelShortName(session.model, session.modelVendor)}
            {session.thinkingLevel === undefined ? "" : ` · ${session.thinkingLevel}`}
          </Text>
        </View>
      )}
    </View>
  );
}

export interface AgentCardProps {
  /** The session `messages` belong to; image bytes are fetched against it. */
  sessionId: string | undefined;
  messages: AgentMessage[] | undefined;
  connected: boolean;
}

/** One session's transcript, pinned to the newest message. */
export function AgentCard({ sessionId, messages, connected }: AgentCardProps) {
  const list = useRef<FlatList<AgentMessage>>(null);
  const atBottom = useRef(true);
  const [viewing, setViewing] = useState<string | null>(null);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    atBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < BOTTOM_STICK_PX;
  };
  const onContentSizeChange = (): void => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: false });
  };

  if (messages === undefined || sessionId === undefined) {
    return <CardPlaceholder text={connected ? "Loading conversation…" : "Connect to your host to load this conversation."} />;
  }
  if (messages.length === 0) return <CardPlaceholder text="No messages yet." />;
  return (
    <>
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => <MessageRow sessionId={sessionId} message={item} onOpenImage={setViewing} />}
        contentContainerStyle={{ paddingVertical: spacing.lg, gap: spacing.sm }}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={onContentSizeChange}
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
