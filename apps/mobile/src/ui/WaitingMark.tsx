import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Text } from "./Text";
import { useColors, withAlpha } from "@/theme";

const EDGE_ALPHA = 0.55;
const GLOW_ALPHA = 0.14;
const TAG_HEIGHT = 18;
/** How far the tag rides above the edge, and how far in from the right corner it sits. */
const TAG_RISE = TAG_HEIGHT / 2;
const TAG_INSET = 14;
const PULSE_UP_MS = 260;
const PULSE_DOWN_MS = 520;
const PULSES = 2;

export interface WaitingMarkProps {
  /** Corner radius of the bubble or card it marks. */
  radius: number;
  /** Grows each time the mark should call attention to itself (a badge tap); the value it mounts with is the quiet state. */
  pulse: number;
  /** The page colour behind the bubble, the tag's fill. */
  page: string;
}

/**
 * The quiet "this is waiting on you" mark on a chat bubble or card that holds an open ask: a thin
 * accent edge and a small "Waiting on you" tag riding its top-right corner, drawn over the bubble
 * without taking any layout room (render it as a child of the bubble's view). A growing `pulse`
 * rings the bubble in a soft accent glow that pulses twice and settles back to the edge. With
 * Reduce Motion the glow holds still for a moment instead. Never receives touches.
 */
export function WaitingMark({ radius, pulse, page }: WaitingMarkProps) {
  const colors = useColors();
  const reduced = useReducedMotion();
  const glow = useSharedValue(0);
  const seen = useRef(pulse);
  useEffect(() => {
    const grew = pulse > seen.current;
    seen.current = pulse;
    if (!grew) return;
    glow.value = reduced
      ? withSequence(withTiming(1, { duration: 0 }), withDelay(PULSES * (PULSE_UP_MS + PULSE_DOWN_MS), withTiming(0, { duration: 200 })))
      : withRepeat(withSequence(withTiming(1, { duration: PULSE_UP_MS }), withTiming(0, { duration: PULSE_DOWN_MS })), PULSES, false);
  }, [pulse, reduced, glow]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeIn.duration(220).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(160).reduceMotion(ReduceMotion.System)}
      style={StyleSheet.absoluteFill}
    >
      <View style={[styles.edge, { borderRadius: radius, borderColor: withAlpha(colors.accent, EDGE_ALPHA) }]} />
      <Animated.View
        style={[styles.glow, { borderRadius: radius + 2, borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, GLOW_ALPHA) }, glowStyle]}
      />
      <View style={[styles.tag, { backgroundColor: page, borderColor: withAlpha(colors.accent, EDGE_ALPHA) }]} accessible accessibilityLabel="Waiting on you">
        <Text variant="caption" color="accent" style={styles.tagText}>
          Waiting on you
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  edge: { ...StyleSheet.absoluteFillObject, borderWidth: 1 },
  glow: { position: "absolute", top: -2, left: -2, right: -2, bottom: -2, borderWidth: 2 },
  tag: {
    position: "absolute",
    top: -TAG_RISE,
    right: TAG_INSET,
    height: TAG_HEIGHT,
    paddingHorizontal: 8,
    justifyContent: "center",
    borderRadius: TAG_HEIGHT / 2,
    borderWidth: 1,
  },
  tagText: { fontSize: 11, lineHeight: 14, fontWeight: "500" },
});
