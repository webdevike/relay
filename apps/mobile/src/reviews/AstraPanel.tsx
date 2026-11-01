/**
 * An item's private Astra session, docked under the composer: Isaac's asks as right bubbles, her
 * answers as markdown (a caret while one streams), tool work as one muted line each, and Use as
 * reply / Stop / Open session. Nothing here is ever posted.
 */
import { useRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { AstraItem } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { portraitOf } from "@/lib/portrait";
import { useAssistantStore } from "@/state/assistant";
import { radii, spacing, useColors } from "@/theme";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";

const ASTRA = { id: "astra" } as const;
/** The panel scrolls past this, so the page above stays reachable. */
const MAX_HEIGHT = 340;

export interface AstraPanelProps {
  item: AstraItem | undefined;
  /** An ask that has not reached the session yet, or failed to. */
  asking: boolean;
  askError: string | null;
  onUseAsReply: (() => void) | null;
  onStop: () => void;
  onOpenSession: (sessionId: string) => void;
}

export function AstraPanel({ item, asking, askError, onUseAsReply, onStop, onOpenSession }: AstraPanelProps) {
  const colors = useColors();
  const scroll = useRef<ScrollView>(null);
  const agent = useAssistantStore((state) => state.agents?.find((a) => a.id === "astra"));
  const working = asking || item?.working === true;
  const sessionId = item?.sessionId ?? null;
  return (
    <View style={[styles.panel, { borderTopColor: colors.hairline, backgroundColor: colors.bg }]} accessibilityLabel="Astra panel">
      <View style={styles.head}>
        <Portrait name="Astra" portrait={portraitOf(agent ?? ASTRA)} size={24} />
        <Text variant="title">Astra</Text>
        <Text variant="caption" color="textMuted" style={styles.private}>
          Private, never posted
        </Text>
        {sessionId !== null && (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open session"
            hitSlop={8}
            onPress={() => {
              onOpenSession(sessionId);
            }}
            style={({ pressed }) => [styles.open, pressed && { opacity: 0.6 }]}
          >
            <Text variant="label" color="accent">
              Open session
            </Text>
            <SymbolView name="arrow.up.right" size={11} tintColor={colors.accent} />
          </Pressable>
        )}
      </View>
      <ScrollView
        ref={scroll}
        style={{ maxHeight: MAX_HEIGHT }}
        contentContainerStyle={styles.turns}
        onContentSizeChange={() => {
          scroll.current?.scrollToEnd({ animated: false });
        }}
      >
        {(item?.turns ?? []).map((turn) => {
          if (turn.role === "user") {
            return (
              <View key={turn.id} style={[styles.mine, { backgroundColor: colors.bubbleUser }]}>
                <Text style={styles.mineText}>{turn.text}</Text>
              </View>
            );
          }
          if (turn.role === "tool") {
            return (
              <Text key={turn.id} variant="caption" color="textFaint" numberOfLines={1}>
                {turn.text}
              </Text>
            );
          }
          return (
            <View key={turn.id}>
              <MessageText text={turn.streaming ? `${turn.text}▍` : turn.text} streaming={turn.streaming} />
            </View>
          );
        })}
        {item?.waiting !== undefined && item.waiting !== null && <Banner tone="warn" icon="hand.raised" message="Astra is waiting on you" detail={item.waiting} detailLines={3} />}
        {(askError ?? item?.error ?? null) !== null && <Banner tone="danger" message={askError ?? item?.error ?? ""} detailLines={3} />}
      </ScrollView>
      <View style={styles.foot}>
        {onUseAsReply !== null && <Button label="Use as reply" variant="secondary" accessibilityLabel="Use as reply" testID="astra-use-as-reply" onPress={onUseAsReply} />}
        {working && sessionId !== null && <Button label="Stop" variant="secondary" accessibilityLabel="Stop Astra" testID="astra-stop" onPress={onStop} />}
        <View style={styles.spacer} />
        {working && (
          <View style={styles.writing} accessibilityLabel="Astra is writing">
            <ActivityIndicator size="small" color={colors.textMuted} />
            <Text variant="caption" color="textMuted">
              Writing
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.sm, gap: spacing.sm },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  private: { flex: 1 },
  open: { flexDirection: "row", alignItems: "center", gap: 4 },
  turns: { gap: spacing.sm, paddingBottom: spacing.xs },
  mine: { alignSelf: "flex-end", maxWidth: "82%", borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  mineText: { color: "#FFFFFF" },
  foot: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  spacer: { flex: 1 },
  writing: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
});
