import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { geometry, ringOpacities } from "@relay/portrait-motion";

/** One turn of the ring, as the animated portrait's Working state spins it. */
const SPIN_MS = 1600;
/** The bright arc's falloff (`ringOpacities` `sharp`) of the Working ring. */
const SHARP = 3;

export interface WorkingRingProps {
  /** The disc's diameter; the dots sit just outside it (`geometry(size).dots`). */
  size: number;
  color: string;
  /** The bright arc goes round; false holds it still (Reduce Motion, off screen). */
  spinning: boolean;
}

/**
 * The animated portrait's working ring of accent dots, cheap: fixed dots in one view that React
 * Native's native Animated driver turns (no JS and no Reanimated shadow-tree commit per frame).
 * Laid over a disc of `size` at its top-left.
 */
export function WorkingRing({ size, color, spinning }: WorkingRingProps) {
  const turn = useRef(new Animated.Value(0)).current;
  const { dots, dotR } = geometry(size);
  const opacities = useMemo(() => ringOpacities(dots.length, 1, 0, SHARP), [dots.length]);

  useEffect(() => {
    if (!spinning) return;
    turn.setValue(0);
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: SPIN_MS, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
    };
  }, [spinning, turn]);

  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View pointerEvents="none" style={[styles.ring, { width: size, height: size, transform: [{ rotate }] }]}>
      {dots.map(([x, y], i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: x - dotR,
            top: y - dotR,
            width: dotR * 2,
            height: dotR * 2,
            borderRadius: dotR,
            backgroundColor: color,
            opacity: opacities[i] ?? 0,
          }}
        />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ring: { position: "absolute", left: 0, top: 0 },
});
