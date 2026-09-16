import { useEffect } from "react";
import { View } from "react-native";
import { SymbolView } from "expo-symbols";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { colors, motion } from "@/theme";

export type MicGlyphMode = "mic" | "wave" | "check";

interface MicGlyphProps {
  mode: MicGlyphMode;
  size: number;
  tintColor: string;
  /** 0..1 microphone level while listening; drives the wave amplitude. */
  level: SharedValue<number>;
}

const BAR_WEIGHTS = [0.45, 0.8, 1, 0.8, 0.45];
const BAR_WIDTH = 3;
const BAR_GAP = 3;

/** The mic button's inner glyph: mic at rest, live waveform while listening, check pop when sent. */
export function MicGlyph({ mode, size, tintColor, level }: MicGlyphProps) {
  const glyph = size * 0.45;
  return (
    <View style={{ width: glyph, height: glyph, alignItems: "center", justifyContent: "center" }}>
      {mode === "wave" && <Waveform height={glyph} level={level} />}
      {mode === "check" && <CheckPop size={glyph} />}
      {mode === "mic" && <SymbolView name="mic.fill" size={glyph} tintColor={tintColor} />}
    </View>
  );
}

function Waveform({ height, level }: { height: number; level: SharedValue<number> }) {
  // Idle breathing so the bars never sit dead-still between words.
  const breath = useSharedValue(0);
  useEffect(() => {
    breath.value = withRepeat(
      withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(breath);
    };
  }, [breath]);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: BAR_GAP, height }}>
      {BAR_WEIGHTS.map((weight, index) => (
        <Bar
          key={index}
          index={index}
          weight={weight}
          height={height}
          level={level}
          breath={breath}
        />
      ))}
    </View>
  );
}

function Bar({
  index,
  weight,
  height,
  level,
  breath,
}: {
  index: number;
  weight: number;
  height: number;
  level: SharedValue<number>;
  breath: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const idle = 0.12 + 0.08 * Math.sin(breath.value * Math.PI + index);
    const amplitude = Math.max(idle, level.value * weight);
    return { height: Math.max(BAR_WIDTH, amplitude * height) };
  });
  return (
    <Animated.View
      style={[
        { width: BAR_WIDTH, borderRadius: BAR_WIDTH / 2, backgroundColor: colors.accent },
        style,
      ]}
    />
  );
}

function CheckPop({ size }: { size: number }) {
  const scale = useSharedValue(0.4);
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(1, { duration: motion.duration.fast });
    scale.value = withDelay(20, withSpring(1, { damping: 12, stiffness: 320 }));
  }, [scale, opacity]);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  return (
    <Animated.View style={style}>
      <SymbolView name="checkmark" size={size} tintColor={colors.ok} weight="bold" />
    </Animated.View>
  );
}
