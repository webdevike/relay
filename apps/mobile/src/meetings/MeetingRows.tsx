/**
 * The meeting view's rows: a transcript line and a moment, both a minute stamp ("14m") in a
 * narrow column beside the words, and the live caret that breathes after what is being said.
 * Blue is the one accent: Isaac's own lines and what is waiting on him.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { momentStamp, type MeetingMoment, type MeetingRow } from "@relay/protocol";
import { radii, spacing, useColors, withAlpha } from "@/theme";
import { Text } from "@/ui/Text";
import { useAnimationActive } from "@/ui/useAnimationActive";
import { momentNeedsYou, rowSpeaker } from "./panel";

/** Half a breath of the caret. */
const CARET_MS = 500;

/** A thin red bar after the live words, breathing; still with Reduce Motion or off screen. */
export function LiveCaret() {
  const colors = useColors();
  const reduced = useReducedMotion();
  const active = useAnimationActive() && !reduced;
  const breath = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      breath.setValue(1);
      return;
    }
    const half = (toValue: number): Animated.CompositeAnimation =>
      Animated.timing(breath, { toValue, duration: CARET_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([half(0.15), half(1)]));
    loop.start();
    return () => {
      loop.stop();
    };
  }, [active, breath]);
  return <Animated.View style={[styles.caret, { backgroundColor: colors.danger, opacity: breath }]} />;
}

export function TranscriptRow({
  row,
  blue,
  lit,
  onLayout,
}: {
  row: MeetingRow;
  blue: boolean;
  lit: boolean;
  onLayout: (e: LayoutChangeEvent) => void;
}) {
  const colors = useColors();
  return (
    <View
      testID="meeting-line"
      onLayout={onLayout}
      style={[styles.row, { backgroundColor: lit ? withAlpha(colors.accent, 0.14) : "transparent" }]}
    >
      <Text variant="caption" color="textFaint" tabular style={styles.stamp}>
        {momentStamp(row.startMs)}
      </Text>
      <View style={styles.words}>
        <Text variant="caption" color={blue ? "accent" : "textMuted"} style={styles.speaker}>
          {rowSpeaker(row)}
        </Text>
        <Text color={row.draft ? "textMuted" : "text"}>{row.text}</Text>
      </View>
    </View>
  );
}

export function MomentRow({ moment, who, onPress }: { moment: MeetingMoment; who: string; onPress: () => void }) {
  const colors = useColors();
  const yours = momentNeedsYou(moment);
  return (
    <Pressable
      testID="meeting-moment"
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surfaceRaised : "transparent" }]}
    >
      <Text variant="caption" color="textFaint" tabular style={styles.stamp}>
        {momentStamp(moment.startMs)}
      </Text>
      <View style={styles.words}>
        <Text color={yours ? "accent" : "text"} style={yours ? styles.yours : undefined}>
          {moment.text}
        </Text>
        <Text variant="caption" color={yours ? "accent" : "textMuted"}>
          {who}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  caret: { width: 2, height: 19, marginLeft: 2 },
  // Lit and pressed backgrounds reach a little past the column; the padding gives it back.
  row: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: 7,
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  stamp: { width: 36, paddingTop: 2 },
  words: { flex: 1 },
  speaker: { fontWeight: "600" },
  yours: { fontWeight: "500" },
});
