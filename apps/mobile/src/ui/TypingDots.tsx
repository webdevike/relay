import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { spacing, useColors } from "@/theme";

const LOOP_MS = 1200;
const DOT = 7;
const DOTS = 3;
/** Opacity of a resting dot, and of every dot when Reduce Motion holds them still. */
const REST = 0.35;

/**
 * iMessage's "is typing" bubble: a small left-aligned bubble in `fill` (the incoming bubble's
 * colour) with three dots that brighten and lift in turn. One VoiceOver element read as `label`.
 * Reduce Motion holds the dots still.
 */
export function TypingDots({ fill, label }: { fill: string; label: string }) {
  const colors = useColors();
  const reducedMotion = useReducedMotion();
  const phase = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    phase.value = withRepeat(withTiming(1, { duration: LOOP_MS, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(phase);
    };
  }, [phase, reducedMotion]);

  return (
    <View accessible accessibilityRole="text" accessibilityLabel={label} style={[styles.bubble, { backgroundColor: fill }]}>
      {Array.from({ length: DOTS }, (_, index) => (
        <Dot key={index} index={index} phase={phase} still={reducedMotion} color={colors.textMuted} />
      ))}
    </View>
  );
}

function Dot({ index, phase, still, color }: { index: number; phase: SharedValue<number>; still: boolean; color: string }) {
  const style = useAnimatedStyle(() => {
    if (still) return { opacity: REST + 0.25, transform: [{ translateY: 0 }] };
    // Each dot peaks a third of a loop after the previous one, and rests for the other half.
    const t = (phase.value - index / DOTS + 1) % 1;
    const lift = t < 0.5 ? Math.sin(t * 2 * Math.PI) : 0;
    return { opacity: REST + (1 - REST) * lift, transform: [{ translateY: -2 * lift }] };
  });
  return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
}

const styles = StyleSheet.create({
  // Sized like a one-line incoming bubble (22 radius, 17pt text's 45pt height).
  bubble: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 45,
    borderRadius: 22,
    paddingHorizontal: spacing.lg,
  },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});
