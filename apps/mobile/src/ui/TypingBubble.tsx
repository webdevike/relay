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
const DOT = 7;
/** Dimmed dot colour in dark mode, as Dot draws them against the #212121 bubble. */
const DOT_DARK = "#4B4B4B";
const BUBBLE_DARK = "#212121";
const DOTS = 3;

/**
 * The "is typing" bubble: a small left-aligned grey thought bubble with a tail of two shrinking
 * circles under its bottom-left and three dimmed dots that light up in sequence.
 */
export function TypingBubble() {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const fill = dark ? BUBBLE_DARK : colors.surface;
  const dotColor = dark ? DOT_DARK : colors.textFaint;
  const phase = useSharedValue(0);

  useEffect(() => {
    phase.value = withRepeat(withTiming(1, { duration: LOOP_MS, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(phase);
    };
  }, [phase]);

  return (
    <View accessible accessibilityLabel="Typing" style={styles.root}>
      <View style={[styles.tailLarge, { backgroundColor: fill }]} />
      <View style={[styles.tailSmall, { backgroundColor: fill }]} />
      <View style={[styles.bubble, { backgroundColor: fill }]}>
        {Array.from({ length: DOTS }, (_, i) => (
          <Dot key={i} index={i} phase={phase} color={dotColor} />
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
  // The tail hangs below the bubble, so the root keeps room under it.
  root: { alignSelf: "flex-start", width: 56, height: 32, marginBottom: 14 },
  // Two circles stepping down and out from the bubble's bottom-left, like a thought bubble.
  tailLarge: { position: "absolute", left: 4, top: 33, width: 9, height: 9, borderRadius: 4.5 },
  tailSmall: { position: "absolute", left: -1, top: 43, width: 5, height: 5, borderRadius: 2.5 },
  bubble: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});
