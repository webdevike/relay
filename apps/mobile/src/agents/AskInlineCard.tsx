import { StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { OpenAsk } from "@relay/protocol";
import { ReplyChips } from "@/ui/ReplyChips";
import { Text } from "@/ui/Text";
import { WaitingMark } from "@/ui/WaitingMark";
import { defaultNote } from "@/lib/openAsks";
import { spacing, useColors } from "@/theme";

const RADIUS = 22;

export interface AskInlineCardProps {
  ask: OpenAsk;
  /** Who asks: the session's title, else the assistant's. */
  source: string;
  /** The bubble fill and the page colour, as the thread's bubbles use. */
  fill: string;
  page: string;
  /** Changes when a badge tap should ring the card (`WaitingMark`). */
  pulse: number;
  /** Tap an answer; null while offline, where the answers are left out. */
  onPick: ((reply: string) => void) | null;
}

/**
 * An open ask that has no bubble in the thread (a session's `asks add`, an `ask` card nobody
 * answered) drawn in the chat where it was asked: who asks, the question, its answers as chips (the
 * default one selected) and, for a session's ask, what it goes with unless Isaac says otherwise.
 * It wears the same `WaitingMark` as a bubble that waits, so the badge scrolls to it the same way.
 */
export function AskInlineCard({ ask, source, fill, page, pulse, onPick }: AskInlineCardProps) {
  const colors = useColors();
  const note = defaultNote(ask);
  return (
    <View style={styles.row}>
      <View style={[styles.card, { backgroundColor: fill }]} testID="ask-inline-card">
        <View style={styles.from}>
          <SymbolView name="questionmark.bubble" size={13} tintColor={colors.accent} />
          <Text variant="label" color="textMuted" numberOfLines={1} style={styles.fromText}>
            {source} asks
          </Text>
        </View>
        <Text style={styles.question}>{ask.question}</Text>
        {note !== null && (
          <Text variant="caption" color="textMuted" style={styles.note}>
            {note}
          </Text>
        )}
        {onPick !== null && ask.replies.length > 0 && (
          <View style={styles.replies}>
            <ReplyChips replies={ask.replies} selected={ask.default} onPick={onPick} />
          </View>
        )}
        <WaitingMark radius={RADIUS} pulse={pulse} page={page} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: spacing.lg },
  card: { alignSelf: "flex-start", maxWidth: "88%", borderRadius: RADIUS, paddingVertical: 12, paddingHorizontal: 17, gap: spacing.xs },
  from: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingRight: 96 },
  fromText: { flexShrink: 1 },
  question: { fontSize: 17, lineHeight: 23 },
  note: { marginTop: 2 },
  replies: { marginTop: spacing.sm },
});
