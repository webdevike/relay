/**
 * Astra in an item's timeline, as a teammate: her cards (portrait, "Astra · AI assistant", a
 * Private mark) with her answer growing in place and her tool work as faint lines, and Isaac's own
 * asks to her as his cards marked Private. Nothing here is ever posted.
 */
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { reviewAgo, type AstraItem, type AstraTurn } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { nameTint } from "@/lib/format";
import { portraitOf } from "@/lib/portrait";
import { useAssistantStore } from "@/state/assistant";
import { spacing, useColors } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { FEED_AVATAR, FeedCard } from "@/ui/FeedCard";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";
import { astraAnswer } from "./model";

const ASTRA = { id: "astra" } as const;
const ACTION_HEIGHT = 32;

/** The lock and words at the right of a private card's header. */
function PrivateMark({ label }: { label: string }) {
  const colors = useColors();
  return (
    <View style={styles.private} accessibilityLabel={label}>
      <SymbolView name="lock.fill" size={10} tintColor={colors.textFaint} />
      <Text variant="caption" color="textFaint" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Isaac's private question to Astra, as his own card. */
export function AskCard({ text, at, now, name }: { text: string; at: number; now: number; name: string }) {
  return (
    <FeedCard
      avatar={<Avatar name={name} size={FEED_AVATAR} tint={nameTint(name)} />}
      name={name}
      meta={Number.isFinite(at) ? `· ${reviewAgo(at, now)}` : undefined}
      badge={<PrivateMark label="Private" />}
    >
      <MessageText text={text} large />
    </FeedCard>
  );
}

export interface AstraCardProps {
  turns: readonly AstraTurn[];
  /** The newest of her cards: it shows her working, waiting or failing, and Stop. */
  last: boolean;
  item: AstraItem | undefined;
  onUseAsReply: (text: string) => void;
  onOpenSession: (sessionId: string) => void;
  onStop: () => void;
}

/** One run of Astra's turns: tool work as faint lines, her answer (a caret while it streams), then her card's actions. */
export function AstraCard({ turns, last, item, onUseAsReply, onOpenSession, onStop }: AstraCardProps) {
  const colors = useColors();
  const agent = useAssistantStore((state) => state.agents?.find((a) => a.id === "astra"));
  const working = last && item?.working === true;
  const streaming = turns.some((turn) => turn.streaming);
  const answer = streaming ? null : astraAnswer(turns);
  const sessionId = item?.sessionId ?? null;
  const waiting = last ? (item?.waiting ?? null) : null;
  const error = last ? (item?.error ?? null) : null;
  return (
    <FeedCard
      avatar={<Portrait name="Astra" portrait={portraitOf(agent ?? ASTRA)} size={FEED_AVATAR} />}
      name="Astra"
      meta="· AI assistant"
      badge={<PrivateMark label="Private, not posted" />}
    >
      {turns.map((turn) =>
        turn.role === "tool" ? (
          <Text key={turn.id} variant="caption" color="textFaint" numberOfLines={1}>
            {turn.text}
          </Text>
        ) : (
          <MessageText key={turn.id} text={turn.streaming ? `${turn.text}▍` : turn.text} streaming={turn.streaming} large />
        ),
      )}
      {working && !streaming && (
        <View style={styles.working} accessibilityLabel="Astra is working">
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text variant="caption" color="textMuted">
            Working
          </Text>
        </View>
      )}
      {waiting !== null && <Banner tone="warn" icon="hand.raised" message="Astra is waiting on you" detail={waiting} detailLines={3} />}
      {error !== null && <Banner tone="danger" message={error} detailLines={3} />}
      {(answer !== null || (working && sessionId !== null)) && (
        <View style={styles.actions}>
          {answer !== null && (
            <Button
              label="Use as reply"
              variant="secondary"
              height={ACTION_HEIGHT}
              testID="astra-use-as-reply"
              onPress={() => {
                onUseAsReply(answer);
              }}
            />
          )}
          {sessionId !== null && (
            <Button
              label="Open session"
              variant="ghost"
              height={ACTION_HEIGHT}
              testID="astra-open-session"
              onPress={() => {
                onOpenSession(sessionId);
              }}
            />
          )}
          {working && sessionId !== null && <Button label="Stop" variant="secondary" tone="danger" height={ACTION_HEIGHT} accessibilityLabel="Stop Astra" testID="astra-stop" onPress={onStop} />}
        </View>
      )}
    </FeedCard>
  );
}

const styles = StyleSheet.create({
  private: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: "auto", flexShrink: 0 },
  working: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm, paddingTop: spacing.xs },
});
