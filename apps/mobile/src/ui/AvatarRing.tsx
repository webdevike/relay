import { useEffect, useState } from "react";
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
import { STATE_META, statusDot, type MotionSignals, type MotionState } from "@relay/portrait-motion";
import type { AssistantPortrait } from "@relay/protocol";
import { loadSkia } from "@/dictation/skia";
import { motion, spacing, useColors, useScheme } from "@/theme";
import { AnimatedPortrait } from "./AnimatedPortrait";
import { Portrait } from "./Portrait";
import { PortraitDot } from "./PortraitDot";
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

/** The portrait comes alive (`ui/AnimatedPortrait`) with what its thread is doing. */
export interface PortraitMotion {
  signals: MotionSignals;
  /** Covered (the call screen over the thread): it holds still. */
  paused?: boolean;
}

export interface AvatarRingProps {
  name: string;
  size?: number;
  /** The ring breathes while true: the agent is working. Ignored with `motion`, whose portrait shows it. */
  breathing?: boolean;
  /** The agent's portrait (`lib/portrait`); with one the hole holds it inside a thin band. */
  portrait?: AssistantPortrait | undefined;
  /** Animate the portrait from these signals instead of breathing the ring. */
  motion?: PortraitMotion | undefined;
}

/**
 * An agent's mark: a translucent ring around a see-through hole (or, given a `portrait`, a thin
 * ring around it; animated with `motion`, no band, so only the portrait's own dot ring shows), and the name on a blurred translucent pill underneath.
 * The ring is drawn with Skia when the build has it, like `IconButton`.
 */
export function AvatarRing({ name, size = RING_SIZE, breathing: breathingProp = false, portrait, motion: live }: AvatarRingProps) {
  const animated = portrait !== undefined && live !== undefined;
  const breathing = breathingProp && !animated;
  const [state, setState] = useState<MotionState | null>(null);
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
  const inner = portrait === undefined ? Math.round(size * INNER_RATIO) : size - 2 * PORTRAIT_BAND;

  const bg = useColors().bg;
  const words = live === undefined ? null : live.signals.waiting ? "needs you" : live.signals.failed ? "the last turn failed" : null;
  const label = animated && state !== null ? [name, STATE_META[state].status, words].filter((part) => part !== null).join(", ") : breathing ? `${name}, working` : name;
  return (
    <View accessible accessibilityLabel={label} style={styles.root}>
      <Animated.View style={[{ width: size, height: size }, ringStyle]}>
        {/* An animated portrait's dot ring runs exactly where the band would be: the band would cover it. */}
        {!animated && <Ring size={size} inner={inner} color={color} />}
        {portrait !== undefined && (
          <View style={styles.portrait}>
            {live === undefined ? (
              <Portrait name={name} portrait={portrait} size={inner} />
            ) : (
              <AnimatedPortrait
                name={name}
                portrait={portrait}
                size={inner}
                signals={live.signals}
                paused={live.paused ?? false}
                onState={setState}
              />
            )}
          </View>
        )}
        {live !== undefined && (
          <PortraitDot tone={statusDot(live.signals)} size={Math.max(10, Math.round(size * 0.2))} edge={bg} style={styles.dot} />
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
  // On the ring's lower left: the Researching magnifier works the lower right.
  dot: { position: "absolute", left: 1, bottom: 1 },
});
