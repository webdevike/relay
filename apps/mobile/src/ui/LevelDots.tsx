import { useEffect } from "react";
import { View } from "react-native";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming, type SharedValue } from "react-native-reanimated";

const DOT = 3;
/** One full turn of the shimmer that keeps a loud line from looking frozen. */
const CYCLE_MS = 900;

export interface LevelDotsProps {
  /** 0..1 loudness, e.g. `dictation/signals` `micLevel`. */
  level: SharedValue<number>;
  /** How many dots in the line. */
  count: number;
  /** Tallest a dot grows (pt) at full level; a quiet line is a row of round dots. */
  height: number;
  color: string;
  gap?: number;
}

/**
 * A live voice meter: a line of small round dots that stretch into bars with the level, tallest in
 * the middle and rippling, flat dots in silence. Under Reduce Motion it stays a still row.
 */
export function LevelDots({ level, count, height, color, gap = 4 }: LevelDotsProps) {
  const clock = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (reduceMotion) return;
    clock.value = withRepeat(withTiming(1, { duration: CYCLE_MS, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(clock);
    };
  }, [clock, reduceMotion]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap, height }}>
      {Array.from({ length: count }, (_, index) => (
        <Dot key={index} index={index} count={count} level={level} clock={clock} height={height} color={color} still={reduceMotion} />
      ))}
    </View>
  );
}

function Dot({ index, count, level, clock, height, color, still }: { index: number; count: number; level: SharedValue<number>; clock: SharedValue<number>; height: number; color: string; still: boolean }) {
  // The middle of the line swings widest; each dot runs a little behind its neighbour.
  const envelope = Math.sin(((index + 1) / (count + 1)) * Math.PI);
  const phase = (index * 0.37) % 1;
  const style = useAnimatedStyle(() => {
    if (still) return { height: DOT };
    const ripple = 0.55 + 0.45 * Math.sin((clock.value + phase) * 2 * Math.PI);
    return { height: DOT + (height - DOT) * Math.min(1, level.value * 1.4) * envelope * ripple };
  });
  return <Animated.View style={[{ width: DOT, borderRadius: DOT / 2, backgroundColor: color }, style]} />;
}
