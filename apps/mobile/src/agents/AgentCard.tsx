import { useRef } from "react";
import { FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { AgentMessage, AgentSession, AgentStatus } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Pill, type PillProps } from "@/ui/Pill";
import { Separator } from "@/ui/Separator";
import { radii, spacing } from "@/theme";

/** Within this many points of the end, new messages keep the list pinned to the bottom. */
const BOTTOM_STICK_PX = 80;

const pillFor: Record<AgentStatus, { label: string; tone: NonNullable<PillProps["tone"]> }> = {
  working: { label: "Working", tone: "accent" },
  waiting: { label: "Waiting for you", tone: "warn" },
  needs_permission: { label: "Needs permission", tone: "warn" },
  idle: { label: "Idle", tone: "textMuted" },
  ended: { label: "Ended", tone: "textMuted" },
};

function MessageRow({ message }: { message: AgentMessage }) {
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
            }}
          >
            <Text variant="body">{message.text}</Text>
          </View>
        </View>
      );
    case "assistant":
      return (
        <View style={{ paddingHorizontal: spacing.xl }}>
          <Text variant="body">{message.text}</Text>
        </View>
      );
    case "tool":
      return (
        <View style={{ paddingHorizontal: spacing.xl }}>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {message.tool === undefined ? message.text : `${message.tool.name}: ${message.tool.summary}`}
          </Text>
        </View>
      );
    case "system":
      return (
        <View style={{ paddingHorizontal: spacing.xl }}>
          <Text variant="caption" color="textMuted">
            {message.text}
          </Text>
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

export interface AgentCardProps {
  session: AgentSession;
  messages: AgentMessage[] | undefined;
  connected: boolean;
}

/** One session's details: title, status, and its transcript pinned to the newest message. */
export function AgentCard({ session, messages, connected }: AgentCardProps) {
  const list = useRef<FlatList<AgentMessage>>(null);
  const atBottom = useRef(true);
  const pill = pillFor[session.status];

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    atBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < BOTTOM_STICK_PX;
  };
  const onContentSizeChange = (): void => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: false });
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.md, gap: spacing.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md }}>
          <Text variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
            {session.title}
          </Text>
          <Pill label={pill.label} tone={pill.tone} />
        </View>
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {session.statusDetail ?? session.projectPath}
        </Text>
      </View>
      <Separator />
      {messages === undefined ? (
        <CardPlaceholder text={connected ? "Loading conversation…" : "Connect to your host to load this conversation."} />
      ) : messages.length === 0 ? (
        <CardPlaceholder text="No messages yet." />
      ) : (
        <FlatList
          ref={list}
          data={messages}
          keyExtractor={(message) => message.id}
          renderItem={({ item }) => <MessageRow message={item} />}
          contentContainerStyle={{ paddingVertical: spacing.lg, gap: spacing.sm }}
          onScroll={onScroll}
          scrollEventThrottle={100}
          onContentSizeChange={onContentSizeChange}
        />
      )}
    </View>
  );
}
