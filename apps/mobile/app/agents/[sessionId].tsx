import { useCallback, useRef } from "react";
import { FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import type { AgentMessage, AgentStatus } from "@relay/protocol";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { Pill, type PillProps } from "@/ui/Pill";
import { Banner } from "@/ui/Banner";
import { Separator } from "@/ui/Separator";
import { colors, radii, spacing } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { useConnectionStore } from "@/state/connection";
import { subscribeAgent, unsubscribeAgent } from "@/connection";
import { DictationButton } from "@/dictation/DictationButton";
import { ListeningOrb } from "@/dictation/ListeningOrb";
import { resetDictationTarget, setDictationTarget } from "@/dictation/deliver";

const MIC_SIZE = 56;
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

function Placeholder({ text }: { text: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxxl }}>
      <Text variant="body" color="textMuted" style={{ textAlign: "center" }}>
        {text}
      </Text>
    </View>
  );
}

/** One agent session: its conversation, live while focused, and the mic that answers it. */
export default function AgentConversation() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const session = useAgentsStore((state) => state.sessions[sessionId]);
  const conversation = useAgentsStore((state) => state.conversations[sessionId]);
  const connected = useConnectionStore((state) => state.status === "connected");
  const list = useRef<FlatList<AgentMessage>>(null);
  const atBottom = useRef(true);

  // Subscriptions live on the socket: re-subscribe whenever the screen is focused on a live connection.
  useFocusEffect(
    useCallback(() => {
      if (!connected) return;
      subscribeAgent(sessionId);
      return () => {
        unsubscribeAgent(sessionId);
      };
    }, [sessionId, connected]),
  );

  useFocusEffect(
    useCallback(() => {
      setDictationTarget({ kind: "agent", sessionId });
      return () => {
        resetDictationTarget();
      };
    }, [sessionId]),
  );

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    atBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < BOTTOM_STICK_PX;
  };
  const onContentSizeChange = (): void => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: false });
  };

  const status = session?.status ?? "ended";
  const pill = pillFor[status];
  const canRespond = session?.canRespond === true;

  return (
    <Screen title={session?.title ?? "Agent"} headerRight={<Pill label={pill.label} tone={pill.tone} />}>
      {session?.statusDetail !== undefined && (
        <View style={{ paddingHorizontal: spacing.xl, paddingBottom: spacing.md }}>
          <Text variant="caption" color="textMuted" numberOfLines={2}>
            {session.statusDetail}
          </Text>
        </View>
      )}
      <Separator />
      <View style={{ flex: 1 }}>
        {conversation === undefined ? (
          <Placeholder text={connected ? "Loading conversation…" : "Connect to your host to load this conversation."} />
        ) : conversation.messages.length === 0 ? (
          <Placeholder text="No messages yet." />
        ) : (
          <FlatList
            ref={list}
            data={conversation.messages}
            keyExtractor={(message) => message.id}
            renderItem={({ item }) => <MessageRow message={item} />}
            contentContainerStyle={{ paddingVertical: spacing.lg, gap: spacing.sm }}
            onScroll={onScroll}
            scrollEventThrottle={100}
            onContentSizeChange={onContentSizeChange}
          />
        )}
        <ListeningOrb />
      </View>
      <Separator />
      <View style={{ alignItems: "center", paddingTop: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm }}>
        {session === undefined ? (
          <Banner tone="warn" message="This session is no longer on the host." />
        ) : !canRespond ? (
          <Banner tone="warn" message="This session can't take replies." />
        ) : (
          <>
            <DictationButton size={MIC_SIZE} backgroundColor={colors.surface} />
            <Text variant="caption" color="textFaint">
              Hold to dictate a follow-up
            </Text>
          </>
        )}
      </View>
    </Screen>
  );
}
