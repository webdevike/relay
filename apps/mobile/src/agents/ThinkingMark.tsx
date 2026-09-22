/**
 * The sign of life beside the activity label: a soft accent core with rings pulsing out of it
 * and fading as they grow, like a slow heartbeat. Drawn with Skia (blurred glow, hairline rings);
 * without Skia in the build it is the plain breathing dot it used to be.
 */
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { loadSkia } from "@/dictation/skia";
import { colors } from "@/theme";

export const THINKING_MARK_SIZE = 18;
/** One full pulse: a ring leaves the core and dies at the edge. */
const PULSE_MS = 1800;
const CORE = 2.6;
/** Radius a ring reaches by the time it has faded out. */
const REACH = THINKING_MARK_SIZE / 2 - 0.5;
/** Rings in flight at once, evenly staggered through the pulse. */
const RINGS = [0, 0.5] as const;
const DOT = 8;

export function ThinkingMark() {
  const sk = loadSkia();
  const clock = useSharedValue(0);
  useEffect(() => {
    clock.value = withRepeat(withTiming(1, { duration: PULSE_MS, easing: Easing.linear }), -1, false);
  }, [clock]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: 0.35 + Math.sin(clock.value * Math.PI) * 0.65 }));
  if (sk === null) {
    return <Animated.View style={[styles.dot, dotStyle]} />;
  }
  return <SkiaMark sk={sk} clock={clock} />;
}

interface SkiaMarkProps {
  sk: NonNullable<ReturnType<typeof loadSkia>>;
  clock: SharedValue<number>;
}

function SkiaMark({ sk, clock }: SkiaMarkProps) {
  const { Canvas, Circle, Blur } = sk;
  const c = THINKING_MARK_SIZE / 2;
  // The core beats at the moment a ring is born, then settles while the ring travels.
  const beat = useDerivedValue(() => {
    const t = (clock.value * RINGS.length) % 1;
    return Math.exp(-t * 4);
  });
  const coreR = useDerivedValue(() => CORE + beat.value * 0.7);
  const glowR = useDerivedValue(() => CORE + 1.5 + beat.value * 1.5);
  const glowOpacity = useDerivedValue(() => 0.25 + beat.value * 0.4);
  const rings = RINGS.map((offset) => useRing(clock, offset));
  return (
    <Canvas style={styles.canvas} pointerEvents="none">
      <Circle cx={c} cy={c} r={glowR} color={colors.accent} opacity={glowOpacity}>
        <Blur blur={2} />
      </Circle>
      {rings.map((ring, i) => (
        <Circle key={i} cx={c} cy={c} r={ring.r} color={colors.accent} opacity={ring.opacity} style="stroke" strokeWidth={1} />
      ))}
      <Circle cx={c} cy={c} r={coreR} color={colors.accent} />
    </Canvas>
  );
}

/** A ring born `offset` of a pulse after the clock's zero: eases outward and fades as it goes. Fixed-length caller keeps hook order stable. */
function useRing(clock: SharedValue<number>, offset: number) {
  const progress = useDerivedValue(() => {
    const t = (clock.value - offset + 1) % 1;
    return 1 - (1 - t) * (1 - t);
  });
  const r = useDerivedValue(() => CORE + progress.value * (REACH - CORE));
  const opacity = useDerivedValue(() => (1 - progress.value) * 0.7);
  return { r, opacity };
}

const styles = StyleSheet.create({
  canvas: { width: THINKING_MARK_SIZE, height: THINKING_MARK_SIZE },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.working, margin: (THINKING_MARK_SIZE - DOT) / 2 },
});
