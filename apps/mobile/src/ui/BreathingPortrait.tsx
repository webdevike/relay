import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import type { DotTone } from "@relay/portrait-motion";
import type { AssistantPortrait } from "@relay/protocol";
import { useColors } from "@/theme";
import { Portrait } from "./Portrait";
import { PortraitDot } from "./PortraitDot";
import { WorkingRing } from "./WorkingRing";
import { useAnimationActive } from "./useAnimationActive";

/** Half a breath (in or out), as the animated portrait's idle breath of 3.4 s. */
const BREATH_MS = 1700;
const BREATH_SCALE = 1.03;

export interface BreathingPortraitProps {
  name: string;
  portrait: AssistantPortrait;
  size: number;
  /** The agent is working: the accent dot ring goes round it. */
  working: boolean;
  /** Its status dot (`state/motion` `listingDot`); leave it out where the row already shows the status. */
  dot?: DotTone;
}

/**
 * A small assistant portrait that is alive without the full animation: it breathes, and while the
 * agent works its accent dot ring turns. Both run on React Native's native Animated driver: a
 * Reanimated loop commits through the shadow tree every frame, which cost a simulator core ~14%
 * for one breathing widget. It holds still off its screen, in the background, and with Reduce
 * Motion (the ring then shows, unmoving). For lists and widgets; the thread and call use
 * `AnimatedPortrait`.
 */
export function BreathingPortrait({ name, portrait, size, working, dot = null }: BreathingPortraitProps) {
  const colors = useColors();
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
      {working && <WorkingRing size={size} color={portrait.colors?.accent ?? colors.accent} spinning={active} />}
      <PortraitDot tone={dot} size={Math.max(8, Math.round(size * 0.24))} edge={colors.surface} style={{ position: "absolute", right: 0, bottom: 0 }} />
    </View>
  );
}
