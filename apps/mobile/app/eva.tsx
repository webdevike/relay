/**
 * Eva, the personal assistant: one durable conversation the host keeps for Isaac, separate from
 * the Agent Inbox. The host owns the thread (`useAssistantStore` mirrors its snapshot while this
 * screen is showing); this screen renders it as a chat, sends a turn with `assistant.turn`, and
 * echoes the sent words until the host's next snapshot carries them.
 */
import { useCallback, useState } from "react";
import { FlatList, KeyboardAvoidingView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { AssistantMessage } from "@relay/protocol";
import { Screen } from "@/ui/Screen";
import { Pill } from "@/ui/Pill";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Callout } from "@/ui/Callout";
import { EmptyState } from "@/ui/EmptyState";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { MessageText } from "@/agents/MessageText";
import { radii, spacing, useColors } from "@/theme";
import { useAssistantStore } from "@/state/assistant";
import { useConnectionStore } from "@/state/connection";
import { requestAssistant, sendCommand, stopAssistant } from "@/connection";
import { notifyHaptic } from "@/lib/haptics";

/** Within this many points of the newest message, a new one keeps the list pinned to it. */
const BOTTOM_STICK_PX = 80;
/** Id of the row echoing a sent turn before the host's snapshot lists it. */
const PENDING_ID = "pending-turn";

export default function Eva() {
  const colors = useColors();
  const snapshot = useAssistantStore((state) => state.snapshot);
  const pending = useAssistantStore((state) => state.pending);
  const setPending = useAssistantStore((state) => state.setPending);
  const connected = useConnectionStore((state) => state.status === "connected");
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

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
  const canSend = connected && text !== "";

  const send = (): void => {
    if (!canSend) return;
    setFailure(null);
    setPending(text);
    setDraft("");
    sendCommand({ kind: "assistant.turn", text }).catch((error: unknown) => {
      notifyHaptic("error");
      // The words come back to the field, so a lost connection never eats a message.
      setPending(null);
      setDraft((current) => (current === "" ? text : current));
      setFailure(error instanceof Error && error.message !== "" ? error.message : "Couldn't reach Eva.");
    });
  };

  const messages = snapshot?.messages ?? [];
  const rows: AssistantMessage[] =
    pending === null ? messages : [...messages, { id: PENDING_ID, role: "user", text: pending.text, at: Date.now() }];
  const newestFirst = [...rows].reverse();
  const busy = snapshot?.busy === true;

  return (
    <Screen title="Eva" headerRight={busy ? <Pill label="Working" tone="accent" /> : undefined}>
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        {failure !== null && (
          <View style={styles.banner}>
            <Banner tone="danger" message={failure} />
          </View>
        )}
        {rows.length === 0 ? (
          <EmptyState
            symbol="bubble.left.and.text.bubble.right"
            title="Say hi to Eva"
            body={connected || snapshot !== null ? "She lives on your Mac and keeps this one conversation going, day and night." : "Connect to your host to load the conversation."}
          />
        ) : (
          <FlatList
            style={styles.fill}
            data={newestFirst}
            inverted
            keyExtractor={(message) => message.id}
            renderItem={({ item }) => <Row message={item} pending={item.id === PENDING_ID} />}
            contentContainerStyle={styles.list}
            maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: BOTTOM_STICK_PX }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          />
        )}
        <View style={[styles.composer, { borderTopColor: colors.hairline }]}>
          <View style={styles.field}>
            <TextField
              value={draft}
              onChangeText={setDraft}
              placeholder={connected ? "Message Eva" : "Not connected"}
              multiline
              editable={connected}
              accessibilityLabel="Message Eva"
            />
          </View>
          <Button label="Send" onPress={send} disabled={!canSend} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Row({ message, pending }: { message: AssistantMessage; pending: boolean }) {
  const colors = useColors();
  switch (message.role) {
    case "user":
      return (
        <View style={styles.userRow}>
          <View style={[styles.bubble, { backgroundColor: colors.surface, opacity: pending ? 0.6 : 1 }]}>
            <Text>{message.text}</Text>
          </View>
        </View>
      );
    case "assistant":
      return (
        <View style={styles.evaRow}>
          <View style={[styles.evaBubble, { borderColor: colors.hairline }]}>
            <MessageText text={message.text} />
          </View>
        </View>
      );
    case "status":
      return (
        <Text variant="caption" color="textMuted" style={styles.status}>
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
  fill: { flex: 1 },
  banner: { paddingBottom: spacing.md },
  list: { paddingVertical: spacing.lg, gap: spacing.md },
  userRow: { alignItems: "flex-end", paddingHorizontal: spacing.xl },
  bubble: { maxWidth: "85%", borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  evaRow: { paddingHorizontal: spacing.xl },
  evaBubble: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  status: { textAlign: "center", paddingHorizontal: spacing.xxxl },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  field: { flex: 1 },
});
