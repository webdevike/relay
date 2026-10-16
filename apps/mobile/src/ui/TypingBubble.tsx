import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useColors, useScheme } from "@/theme";

const LOOP_MS = 1000;
const DOT = 8;
const DOTS = 3;

/**
 * The "is typing" bubble: a small left-aligned grey bubble with a tail at its bottom-left and
 * three muted dots that light up in sequence.
 */
export function TypingBubble() {
  const colors = useColors();
  const fill = useScheme() === "dark" ? colors.surfaceRaised : colors.surface;
  const phase = useSharedValue(0);

  useEffect(() => {
    phase.value = withRepeat(withTiming(1, { duration: LOOP_MS, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(phase);
    };
  }, [phase]);

  return (
    <View accessible accessibilityLabel="Typing" style={styles.root}>
      <View style={[styles.tail, { backgroundColor: fill }]} />
      <View style={[styles.bubble, { backgroundColor: fill }]}>
        {Array.from({ length: DOTS }, (_, i) => (
          <Dot key={i} index={i} phase={phase} color={colors.textMuted} />
        ))}
      </View>
    </View>
  );
}

function Dot({ index, phase, color }: { index: number; phase: SharedValue<number>; color: string }) {
  const style = useAnimatedStyle(() => {
    // Each dot peaks a third of a loop after the previous one.
    const t = (phase.value - index / DOTS + 1) % 1;
    const lift = t < 0.5 ? t * 2 : (1 - t) * 2;
    return { opacity: 0.35 + 0.65 * lift, transform: [{ translateY: -2 * lift }] };
  });
  return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
}

const styles = StyleSheet.create({
  root: { alignSelf: "flex-start", width: 56, height: 36 },
  // A small square under the bubble's bottom-left corner, filling the rounded corner into a tail point.
  tail: { position: "absolute", left: 0, bottom: 0, width: 10, height: 10, borderBottomLeftRadius: 2 },
  bubble: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});
