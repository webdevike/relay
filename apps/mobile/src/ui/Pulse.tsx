import { useEffect, type ReactNode } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/** One breath of the pulse, out and back. */
const PULSE_MS = 900;
/** How faint the pulse gets at its lowest. */
const LOW = 0.35;

/**
 * Fades `children` softly in and out while `active` (something runs now), on the UI thread; still at full
 * strength when off and under Reduce Motion.
 */
export function Pulse({ active, children }: { active: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!active || reduced) {
      cancelAnimation(opacity);
      opacity.value = withTiming(1, { duration: 150 });
      return;
    }
    opacity.value = withRepeat(
      withTiming(LOW, { duration: PULSE_MS, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(opacity);
    };
  }, [active, reduced, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}
