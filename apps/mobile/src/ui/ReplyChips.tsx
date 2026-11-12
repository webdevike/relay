import { useRef, useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { Chip } from "./Chip";
import { spacing } from "@/theme";

/** Each 28pt chip reaches a 44pt touch target; sideways it stays inside half the gap, so neighbours never overlap. */
const HIT_SLOP = { top: spacing.sm, bottom: spacing.sm, left: spacing.xs, right: spacing.xs };

export interface ReplyChipsProps {
  /** Two to four short answers, each the exact words sent when tapped. */
  replies: readonly string[];
  onPick: (reply: string) => void;
  /** The answer a session's ask goes with unless Isaac says otherwise: its chip is drawn selected. */
  selected?: string | undefined;
  /** A last element in the same wrapping row (the open-questions sheet's "Other" chip). */
  trailing?: ReactNode;
}

/**
 * Tap-to-answer replies under a chat bubble: a wrapping row of `Chip`s, left-aligned, fading in. One
 * VoiceOver group, "Suggested replies", with a button per answer. Nothing is sent without a tap, and
 * one tap sends once: the tapped chip is drawn selected and the row takes no more taps (a ref, so
 * taps that queued while the JS thread was busy see it before the screen redraws).
 */
export function ReplyChips({ replies, onPick, selected, trailing }: ReplyChipsProps) {
  const picked = useRef<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <Animated.View
      entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)}
      style={styles.row}
      accessibilityRole="toolbar"
      accessibilityLabel="Suggested replies"
    >
      {replies.map((reply) => (
        <Chip
          key={reply}
          label={reply}
          selected={chosen === null ? reply === selected : reply === chosen}
          hitSlop={HIT_SLOP}
          onPress={() => {
            if (picked.current !== null) return;
            picked.current = reply;
            setChosen(reply);
            onPick(reply);
          }}
        />
      ))}
      {trailing}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: spacing.sm },
});
