/**
 * A card you throw left or right. It follows the finger (tilting up to `MAX_TILT_DEG`), and a release
 * past `THRESHOLD_FRACTION` of the screen width, or a fling, sends it off that side; anything less
 * springs it back. Crossing the threshold ticks a haptic. `swipe(direction)` (the deck's buttons)
 * throws it the same way. All motion runs on the UI thread; `onSwiped` fires once it is off screen.
 *
 * `overlay` gets the signed drag progress (-1 at the left threshold, 1 at the right) to tint the
 * card; `stack` receives its magnitude so a deck can raise the card underneath as this one leaves.
 */
import { useImperativeHandle, useMemo, type ReactNode, type Ref } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { impactHaptic } from "@/lib/haptics";

export type SwipeDirection = "left" | "right";

export interface SwipeCardHandle {
  /** Throws the card off `direction`; ignored while it is already leaving. */
  swipe: (direction: SwipeDirection) => void;
}

export interface SwipeCardProps {
  children: ReactNode;
  onSwiped: (direction: SwipeDirection) => void;
  overlay?: ((progress: SharedValue<number>) => ReactNode) | undefined;
  /** Written with |progress| (0..1) while the card moves. */
  stack?: SharedValue<number>;
  ref?: Ref<SwipeCardHandle>;
}

/** Share of the screen width a drag must pass for a release to count. */
export const THRESHOLD_FRACTION = 0.35;
const MAX_TILT_DEG = 12;
/** A release this fast (pt/s) toward a side throws the card even short of the threshold. */
const FLING_VELOCITY = 900;
const FLING_MIN_TRAVEL = 30;
/** Floor speed (pt/s) for a throw, so a slow release still leaves briskly. */
const MIN_FLY_SPEED = 1600;
const MAX_FLY_MS = 320;
const BUTTON_FLY_MS = 380;
/** The card follows the finger's vertical travel at this share, so a throw reads as horizontal. */
const VERTICAL_FOLLOW = 0.35;
const SPRING = { damping: 18, stiffness: 220, mass: 0.8 } as const;

export function SwipeCard({ children, onSwiped, overlay, stack, ref }: SwipeCardProps) {
  const { width } = useWindowDimensions();
  const threshold = width * THRESHOLD_FRACTION;
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const armed = useSharedValue(false);
  const leaving = useSharedValue(false);
  // Pan activates after ~10pt; subtracting that slop keeps the card from jumping on pickup.
  const slopX = useSharedValue(0);
  const slopY = useSharedValue(0);
  const progress = useDerivedValue(() => Math.max(-1, Math.min(1, x.value / threshold)));

  useAnimatedReaction(
    () => Math.abs(progress.value),
    (magnitude, previous) => {
      // The first run is this card mounting: leave the deck's own settle animation alone.
      if (previous !== null && stack !== undefined) stack.value = magnitude;
    },
  );

  const fly = useMemo(
    () =>
      (direction: SwipeDirection, duration: number): void => {
        "worklet";
        leaving.value = true;
        const target = (direction === "right" ? 1 : -1) * width * 1.4;
        x.value = withTiming(target, { duration, easing: Easing.out(Easing.quad) }, (finished) => {
          if (finished === true) scheduleOnRN(onSwiped, direction);
        });
      },
    [leaving, onSwiped, width, x],
  );

  useImperativeHandle(
    ref,
    () => ({
      swipe: (direction) => {
        if (leaving.value) return;
        fly(direction, BUTTON_FLY_MS);
      },
    }),
    [fly, leaving],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Vertical drags belong to the card's scrolling body.
        .activeOffsetX([-10, 10])
        .failOffsetY([-14, 14])
        .onStart((event) => {
          slopX.value = event.translationX - x.value;
          slopY.value = event.translationY * VERTICAL_FOLLOW - y.value;
        })
        .onUpdate((event) => {
          if (leaving.value) return;
          x.value = event.translationX - slopX.value;
          y.value = event.translationY * VERTICAL_FOLLOW - slopY.value;
          const past = Math.abs(x.value) >= threshold;
          if (past !== armed.value) {
            armed.value = past;
            if (past) scheduleOnRN(impactHaptic, "medium");
          }
        })
        .onEnd((event) => {
          if (leaving.value) return;
          armed.value = false;
          const flung =
            Math.abs(event.velocityX) >= FLING_VELOCITY &&
            Math.sign(event.velocityX) === Math.sign(x.value) &&
            Math.abs(x.value) >= FLING_MIN_TRAVEL;
          if (Math.abs(x.value) >= threshold || flung) {
            const direction = x.value > 0 ? "right" : "left";
            // Carry the release speed into the throw so the card never slows on let-go.
            const remaining = width * 1.4 - Math.abs(x.value);
            const speed = Math.max(MIN_FLY_SPEED, Math.abs(event.velocityX));
            const duration = Math.min(MAX_FLY_MS, (remaining / speed) * 1000 * 1.6);
            fly(direction, duration);
            y.value = withTiming(y.value + event.velocityY * 0.05, { duration });
            return;
          }
          x.value = withSpring(0, { ...SPRING, velocity: event.velocityX });
          y.value = withSpring(0, { ...SPRING, velocity: event.velocityY * VERTICAL_FOLLOW });
        }),
    [armed, fly, leaving, slopX, slopY, threshold, width, x, y],
  );

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { rotate: `${interpolate(x.value, [-width / 2, 0, width / 2], [-MAX_TILT_DEG, 0, MAX_TILT_DEG], Extrapolation.CLAMP)}deg` },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[StyleSheet.absoluteFill, style]}>
        {children}
        {overlay?.(progress)}
      </Animated.View>
    </GestureDetector>
  );
}
