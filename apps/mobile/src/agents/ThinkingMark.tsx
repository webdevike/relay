/**
 * The sign of life beside the activity label: a soft accent core that breathes, with a spark
 * circling it and a short comet tail behind. Drawn with Skia (blurred glow, sub-pixel motion);
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
const BREATH_MS = 900;
const ORBIT_MS = 2200;
const CORE = 2.6;
const ORBIT = 6.2;
const SPARK = 1.4;
/** Tail beads behind the spark, each a step back along the orbit and a step fainter. */
/** Fixed length: the hooks called per bead keep a stable order. */
const TAIL = [0.22, 0.44, 0.66] as const;
const TAIL_STEP = 0.06;
const DOT = 8;

export function ThinkingMark() {
  const sk = loadSkia();
  const breath = useSharedValue(0);
  const turn = useSharedValue(0);
  useEffect(() => {
    breath.value = withRepeat(withTiming(1, { duration: BREATH_MS, easing: Easing.inOut(Easing.ease) }), -1, true);
    turn.value = withRepeat(withTiming(1, { duration: ORBIT_MS, easing: Easing.linear }), -1, false);
  }, [breath, turn]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: 0.35 + breath.value * 0.65 }));
  if (sk === null) {
    return <Animated.View style={[styles.dot, dotStyle]} />;
  }
  return <SkiaMark sk={sk} breath={breath} turn={turn} />;
}

interface SkiaMarkProps {
  sk: NonNullable<ReturnType<typeof loadSkia>>;
  breath: SharedValue<number>;
  turn: SharedValue<number>;
}

function SkiaMark({ sk, breath, turn }: SkiaMarkProps) {
  const { Canvas, Circle, Blur, Group } = sk;
  const c = THINKING_MARK_SIZE / 2;
  const coreR = useDerivedValue(() => CORE + breath.value * 0.8);
  const glowR = useDerivedValue(() => CORE + 2 + breath.value * 1.6);
  const glowOpacity = useDerivedValue(() => 0.35 + breath.value * 0.35);
  // The spark and its tail share one clock; each bead lags the head a little further round.
  const head = useBead(turn, 0, c);
  const beads = TAIL.map((fade, i) => ({ fade, ...useBead(turn, TAIL_STEP * (i + 1), c) }));
  return (
    <Canvas style={styles.canvas} pointerEvents="none">
      <Group>
        <Circle cx={c} cy={c} r={glowR} color={colors.accent} opacity={glowOpacity}>
          <Blur blur={2.5} />
        </Circle>
      </Group>
      <Circle cx={c} cy={c} r={coreR} color={colors.accent} />
      {beads.map((bead, i) => (
        <Circle key={i} cx={bead.x} cy={bead.y} r={SPARK * (1 - bead.fade * 0.7)} color={colors.text} opacity={(1 - bead.fade) * 0.55} />
      ))}
      <Circle cx={head.x} cy={head.y} r={SPARK} color={colors.text} />
    </Canvas>
  );
}

/** A point on the orbit `lag` turns behind the clock. */
function useBead(turn: SharedValue<number>, lag: number, c: number) {
  const x = useDerivedValue(() => c + Math.cos((turn.value - lag) * Math.PI * 2) * ORBIT);
  const y = useDerivedValue(() => c + Math.sin((turn.value - lag) * Math.PI * 2) * ORBIT * 0.72);
  return { x, y };
}

const styles = StyleSheet.create({
  canvas: { width: THINKING_MARK_SIZE, height: THINKING_MARK_SIZE },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.working, margin: (THINKING_MARK_SIZE - DOT) / 2 },
});
