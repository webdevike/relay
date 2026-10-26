import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { loadSkia } from "@/dictation/skia";
import { motion, spacing, useScheme } from "@/theme";
import { Portrait } from "./Portrait";
import { Text } from "./Text";

/** A full ring breath, out and back: the loop runs 1.0 to 1.06 in this long each way. */
const BREATH_MS = 1200;
const BREATH_SCALE = 1.06;
const INNER_RATIO = 27 / 65;
/** Height of the name pill under the ring. */
export const NAME_PILL_HEIGHT = 34;
/** Gap between the ring and the name pill. */
export const NAME_PILL_GAP = spacing.sm - 2;
/** Default outer diameter of the ring. */
export const RING_SIZE = 65;

/** Width of the band around a portrait. */
const PORTRAIT_BAND = 3;

// A ring: a pale translucent band around a transparent hole, so the blurred page shows through its centre.
const RING = {
  dark: "rgba(188,193,211,0.85)",
  light: "rgba(70,80,110,0.55)",
} as const;

export interface AvatarRingProps {
  name: string;
  size?: number;
  /** The ring breathes while true: the agent is working. */
  breathing?: boolean;
  /** The agent's portrait seed (`lib/portrait`); with one the hole holds its portrait inside a thin band. */
  seed?: string | undefined;
}

/**
 * An agent's mark: a translucent ring around a see-through hole (or, given a `seed`, a thin ring
 * around its portrait), and the name on a blurred translucent pill underneath. The ring is drawn
 * with Skia when the build has it, like `IconButton`.
 */
export function AvatarRing({ name, size = RING_SIZE, breathing = false, seed }: AvatarRingProps) {
  const scheme = useScheme();
  const color = RING[scheme];
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
  const inner = seed === undefined ? Math.round(size * INNER_RATIO) : size - 2 * PORTRAIT_BAND;

  return (
    <View accessible accessibilityLabel={breathing ? `${name}, working` : name} style={styles.root}>
      <Animated.View style={[{ width: size, height: size }, ringStyle]}>
        <Ring size={size} inner={inner} color={color} />
        {seed !== undefined && (
          <View style={styles.portrait}>
            <Portrait name={name} seed={seed} size={inner} />
          </View>
        )}
      </Animated.View>
      <BlurView intensity={40} tint={scheme} style={styles.chip}>
        <Text style={styles.name}>{name}</Text>
      </BlurView>
    </View>
  );
}

function Ring({ size, inner, color }: { size: number; inner: number; color: string }) {
  const sk = loadSkia();
  const band = (size - inner) / 2;
  if (sk === null) {
    return <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: band, borderColor: color }} />;
  }
  return (
    <sk.Canvas style={{ width: size, height: size }}>
      <sk.Circle cx={size / 2} cy={size / 2} r={size / 2 - band / 2} style="stroke" strokeWidth={band} color={color} />
    </sk.Canvas>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", gap: NAME_PILL_GAP },
  chip: { height: NAME_PILL_HEIGHT, borderRadius: NAME_PILL_HEIGHT / 2, overflow: "hidden", paddingHorizontal: spacing.md + 2, alignItems: "center", justifyContent: "center" },
  name: { fontSize: 17, lineHeight: 22, fontWeight: "700" },
  portrait: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
