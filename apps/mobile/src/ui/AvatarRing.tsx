import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { loadSkia } from "@/dictation/skia";
import { motion, spacing, useColors, useScheme } from "@/theme";
import { Text } from "./Text";

/** A full ring breath, out and back: the loop runs 1.0 to 1.06 in this long each way. */
const BREATH_MS = 1200;
const BREATH_SCALE = 1.06;
const INNER_RATIO = 44 / 72;

const RING = {
  dark: { outer: "rgba(255,255,255,0.35)", inner: "#C9C9CF" },
  light: { outer: "rgba(0,0,0,0.12)", inner: "rgba(0,0,0,0.28)" },
} as const;

export interface AvatarRingProps {
  name: string;
  size?: number;
  /** The ring breathes while true: the agent is working. */
  breathing?: boolean;
}

/**
 * An agent's mark: a translucent disc with a smaller solid disc inside, and the name on a dark
 * pill chip underneath. Discs are drawn with Skia when the build has it, like `IconButton`.
 */
export function AvatarRing({ name, size = 72, breathing = false }: AvatarRingProps) {
  const colors = useColors();
  const palette = RING[useScheme()];
  const scale = useSharedValue(1);

  useEffect(() => {
    if (!breathing) {
      cancelAnimation(scale);
      scale.value = withTiming(1, { duration: motion.duration.base });
      return;
    }
    scale.value = withRepeat(withTiming(BREATH_SCALE, { duration: BREATH_MS, easing: Easing.inOut(Easing.ease) }), -1, true);
    return () => {
      cancelAnimation(scale);
    };
  }, [breathing, scale]);

  const ringStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const inner = Math.round(size * INNER_RATIO);

  return (
    <View accessible accessibilityLabel={breathing ? `${name}, working` : name} style={styles.root}>
      <Animated.View style={[{ width: size, height: size }, ringStyle]}>
        <Disc size={size} color={palette.outer} />
        <View style={styles.center}>
          <Disc size={inner} color={palette.inner} />
        </View>
      </Animated.View>
      <View style={[styles.chip, { backgroundColor: colors.surfaceRaised }]}>
        <Text style={styles.name}>{name}</Text>
      </View>
    </View>
  );
}

function Disc({ size, color }: { size: number; color: string }) {
  const sk = loadSkia();
  if (sk === null) {
    return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
  }
  return (
    <sk.Canvas style={{ width: size, height: size }}>
      <sk.Circle cx={size / 2} cy={size / 2} r={size / 2} color={color} />
    </sk.Canvas>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", gap: spacing.sm - 2 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  chip: { borderRadius: 14, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  name: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
});
