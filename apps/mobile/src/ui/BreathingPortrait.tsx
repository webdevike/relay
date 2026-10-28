import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import type { AssistantPortrait } from "@relay/protocol";
import { Portrait } from "./Portrait";
import { useAnimationActive } from "./useAnimationActive";

/** Half a breath (in or out), as the animated portrait's idle breath of 3.4 s. */
const BREATH_MS = 1700;
const BREATH_SCALE = 1.03;

export interface BreathingPortraitProps {
  name: string;
  portrait: AssistantPortrait;
  size: number;
  /** The agent is working: only its VoiceOver label says so; the breath stays the same. */
  working: boolean;
}

/**
 * A small assistant portrait that is alive without the full animation: it breathes, on React
 * Native's native Animated driver (a Reanimated loop commits through the shadow tree every frame,
 * which cost a simulator core ~14% for one breathing widget). It holds still off its screen, in
 * the background, and with Reduce Motion. No status dot or ring: the face alone stands for the
 * agent. For lists and widgets; the thread and call use `AnimatedPortrait`.
 */
export function BreathingPortrait({ name, portrait, size, working }: BreathingPortraitProps) {
  const reduced = useReducedMotion();
  const active = useAnimationActive() && !reduced;
  const breath = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      breath.setValue(0);
      return;
    }
    const half = (toValue: number): Animated.CompositeAnimation =>
      Animated.timing(breath, { toValue, duration: BREATH_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([half(1), half(0)]));
    loop.start();
    return () => {
      loop.stop();
    };
  }, [active, breath]);

  const scale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, BREATH_SCALE] });
  return (
    <View accessible accessibilityLabel={working ? `${name}, working` : name} style={{ width: size, height: size }}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Portrait name={name} portrait={portrait} size={size} />
      </Animated.View>
    </View>
  );
}
