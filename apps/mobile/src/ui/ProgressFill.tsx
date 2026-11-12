import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { withAlpha } from "@/theme";
import { useAnimationActive } from "./useAnimationActive";

/** Low contrast on purpose: the label on top reads exactly as it does without a fill. */
const FILL_ALPHA = 0.2;
const STRIPE_ALPHA = 0.26;
/** Distance between stripes, their width, and how many cover the widest chip (200pt) plus the slant. */
const STRIPE_PERIOD = 10;
const STRIPE_WIDTH = 4;
const STRIPE_FIRST = -6;
const STRIPE_COUNT = 40;
const STRIPE_HEIGHT = 120;
/** One stripe period of drift: slow enough to read as alive, never as motion. */
const DRIFT_MS = 2600;
/** The pulse: the fill breathes between full and this share of its strength, one breath per two periods. */
const PULSE_LOW = 0.5;
const PULSE_MS = 1600;
/** The fill catching up to a fresher fraction, unless the caller says otherwise. */
const GROW_MS = 900;

export interface ProgressFillProps {
  /** 0..1 of the parent's width, from the left. Changes animate smoothly. */
  fraction: number;
  /** `#RRGGBB`; drawn at low alpha. */
  color: string;
  /** Opacity of the solid fill; default 0.2. */
  alpha?: number;
  /** Opacity of the stripes; default 0.26. */
  stripeAlpha?: number;
  /** Breathes slowly (still under Reduce Motion or off screen). */
  pulse?: boolean;
  /** `striped`: soft diagonal stripes that drift slowly (still under Reduce Motion or off screen). */
  texture: "solid" | "striped";
  /** How long a change of `fraction` takes to draw; default a calm catch-up. */
  growMs?: number;
}

/**
 * A progress fill laid under content: it covers `fraction` of its parent from the left edge and
 * fills its height, so the parent (clipped to its own shape, e.g. `ui/Chip`'s `background` slot) decides
 * the outline. Solid, or soft diagonal stripes in the same color. Draws no text and takes no touches.
 */
export function ProgressFill({ fraction, color, texture, alpha = FILL_ALPHA, stripeAlpha = STRIPE_ALPHA, pulse = false, growMs = GROW_MS }: ProgressFillProps) {
  const grown = useSharedValue(fraction);
  useEffect(() => {
    grown.value = withTiming(fraction, { duration: growMs, easing: Easing.out(Easing.cubic) });
  }, [grown, fraction, growMs]);
  const reduced = useReducedMotion();
  const active = useAnimationActive() && !reduced;
  const breath = useSharedValue(1);
  const breathing = pulse && active;
  useEffect(() => {
    if (!breathing) return;
    breath.value = withRepeat(withSequence(withTiming(PULSE_LOW, { duration: PULSE_MS, easing: Easing.inOut(Easing.quad) }), withTiming(1, { duration: PULSE_MS, easing: Easing.inOut(Easing.quad) })), -1, false);
    return () => {
      cancelAnimation(breath);
      breath.value = 1;
    };
  }, [breath, breathing]);
  const style = useAnimatedStyle(() => ({ width: `${grown.value * 100}%`, opacity: breath.value }));
  return (
    <Animated.View pointerEvents="none" style={[styles.fill, texture === "solid" && { backgroundColor: withAlpha(color, alpha) }, style]}>
      {texture === "striped" && <Stripes color={color} alpha={stripeAlpha} />}
    </Animated.View>
  );
}

function Stripes({ color, alpha }: { color: string; alpha: number }) {
  const reduced = useReducedMotion();
  const active = useAnimationActive() && !reduced;
  const clock = useSharedValue(0);
  useEffect(() => {
    if (!active) return;
    clock.value = withRepeat(withTiming(1, { duration: DRIFT_MS, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(clock);
      clock.value = 0;
    };
  }, [clock, active]);
  const drift = useAnimatedStyle(() => ({ transform: [{ translateX: clock.value * STRIPE_PERIOD }] }));
  const bar = withAlpha(color, alpha);
  return (
    <Animated.View style={[styles.stripes, drift]}>
      {Array.from({ length: STRIPE_COUNT }, (_, index) => (
        <View key={index} style={[styles.stripe, { left: (STRIPE_FIRST + index) * STRIPE_PERIOD, backgroundColor: bar }]} />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, overflow: "hidden" },
  stripes: { position: "absolute", left: 0, top: 0, bottom: 0, width: STRIPE_COUNT * STRIPE_PERIOD },
  stripe: { position: "absolute", top: "50%", marginTop: -STRIPE_HEIGHT / 2, width: STRIPE_WIDTH, height: STRIPE_HEIGHT, transform: [{ rotate: "45deg" }] },
});
