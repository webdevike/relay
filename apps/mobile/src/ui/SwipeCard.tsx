/**
 * A card you throw left or right. It follows the finger (tilting up to `MAX_TILT_DEG`), and a release
 * past `THRESHOLD_FRACTION` of the screen width, or a fling, sends it off that side; anything less
 * springs it back. Crossing the threshold ticks a haptic. `swipe(direction)` (the deck's buttons)
 * throws it the same way; `onSwiped` fires once it is off screen.
 *
 * Every moving frame runs on React Native's native Animated driver: the pan's translation feeds
 * `Animated.event(..., { useNativeDriver: true })` and the throw and spring-back are native
 * timings, so a frame only sets transforms and opacities on the cards' own views. Reanimated would
 * commit each frame through the React shadow tree instead, and on iOS (Reanimated 4.1) that commit
 * re-rounds the whole tree's layout and makes every mounted ScrollView re-walk its subviews, so a
 * long markdown card made every frame of the drag slower.
 *
 * Only the top card moves, so a deck has one `DeckMotion` and every card is wired to it once,
 * weighted by its role (`CardRoles`, three 0/1 values): the top card follows the drag, the one
 * underneath grows as the drag grows, the rest wait. A throw changes those weights with `setValue`,
 * never the animated graph, so nothing is detached mid-flight and no view keeps a stale transform.
 * The face is rasterized while it moves or waits underneath, so iOS composites one bitmap per card
 * instead of every text layer of a long body; it renders live only while it sits still on top.
 */
import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Animated, Easing, StyleSheet } from "react-native";
import {
  PanGestureHandler,
  State,
  type PanGestureHandlerEventPayload,
  type PanGestureHandlerStateChangeEvent,
} from "react-native-gesture-handler";
import { impactHaptic } from "@/lib/haptics";

export type SwipeDirection = "left" | "right";

/** Signed drag progress: -1 at the left threshold, 0 at rest, 1 at the right threshold. */
export type SwipeProgress = Animated.AnimatedInterpolation<number>;

export interface SwipeCardHandle {
  /** Throws the card off `direction`; ignored unless it is the top card and still. */
  swipe: (direction: SwipeDirection) => void;
}

/** The top card's motion, all native-driven: the pan writes `dragX/dragY`, releases animate `offsetX/offsetY`. */
export interface DeckMotion {
  width: number;
  dragX: Animated.Value;
  dragY: Animated.Value;
  offsetX: Animated.Value;
  offsetY: Animated.Value;
  x: Animated.AnimatedAddition<number>;
  y: Animated.AnimatedAddition<number>;
  progress: SwipeProgress;
  /** |progress|, 0..1. */
  magnitude: SwipeProgress;
  /** Where the offsets left the card: a JS copy of what the native driver shows, added to the next pan. */
  rest: { x: number; y: number };
}

export type SwipeCardRole = "top" | "under" | "waiting";

/** One card's role as native values (1 for its role, 0 otherwise). */
export type CardRoles = Record<SwipeCardRole, Animated.Value>;

/** Share of the screen width a drag must pass for a release to count. */
export const THRESHOLD_FRACTION = 0.35;
/** The waiting card's scale; it shrinks toward its bottom edge. */
const UNDER_SCALE = 0.94;
/** How much of the waiting card peeks out below the top one; leave this much room under the deck. */
export const UNDER_DROP = 12;
const MAX_TILT_DEG = 12;
/** The pan activates after this much horizontal travel; the card starts from there, so it never jumps. */
const ACTIVE_OFFSET = 10;
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

/** Where the card is for a pan translation: the activation slop taken off, so it starts at 0. */
function slopped(translationX: number): number {
  return Math.sign(translationX) * Math.max(0, Math.abs(translationX) - ACTIVE_OFFSET);
}

export function createDeckMotion(width: number): DeckMotion {
  const dragX = new Animated.Value(0);
  const dragY = new Animated.Value(0);
  const offsetX = new Animated.Value(0);
  const offsetY = new Animated.Value(0);
  const threshold = width * THRESHOLD_FRACTION;
  // `slopped` as a native interpolation: flat within the slop, slope 1 beyond it.
  const following = dragX.interpolate({
    inputRange: [-ACTIVE_OFFSET - 1, -ACTIVE_OFFSET, ACTIVE_OFFSET, ACTIVE_OFFSET + 1],
    outputRange: [-1, 0, 0, 1],
    extrapolate: "extend",
  });
  const x = Animated.add(following, offsetX);
  const y = Animated.add(Animated.multiply(dragY, VERTICAL_FOLLOW), offsetY);
  const progress = x.interpolate({ inputRange: [-threshold, threshold], outputRange: [-1, 1], extrapolate: "clamp" });
  const magnitude = progress.interpolate({ inputRange: [-1, 0, 1], outputRange: [1, 0, 1] });
  return { width, dragX, dragY, offsetX, offsetY, x, y, progress, magnitude, rest: { x: 0, y: 0 } };
}

/** Puts the deck's motion back at rest for the next top card. */
export function resetDeckMotion(motion: DeckMotion): void {
  for (const value of [motion.dragX, motion.dragY, motion.offsetX, motion.offsetY]) {
    value.stopAnimation();
    value.setValue(0);
  }
  motion.rest = { x: 0, y: 0 };
}

export function createCardRoles(role: SwipeCardRole): CardRoles {
  return {
    top: new Animated.Value(role === "top" ? 1 : 0),
    under: new Animated.Value(role === "under" ? 1 : 0),
    waiting: new Animated.Value(role === "waiting" ? 1 : 0),
  };
}

export interface SwipeCardProps {
  children: ReactNode;
  motion: DeckMotion;
  roles: CardRoles;
  role: SwipeCardRole;
  onSwiped: (direction: SwipeDirection) => void;
  overlay?: ((progress: SwipeProgress) => ReactNode) | undefined;
  ref?: Ref<SwipeCardHandle> | undefined;
}

export function SwipeCard({ children, motion, roles, role, onSwiped, overlay, ref }: SwipeCardProps) {
  const { width, dragX, dragY, offsetX, offsetY } = motion;
  const threshold = width * THRESHOLD_FRACTION;
  const leaving = useRef(false);
  const dragging = useRef(false);
  const armed = useRef(false);
  const [moving, setMoving] = useState(false);

  // Roles change by value, before the frame that shows the new deck.
  useLayoutEffect(() => {
    roles.top.setValue(role === "top" ? 1 : 0);
    roles.under.setValue(role === "under" ? 1 : 0);
    roles.waiting.setValue(role === "waiting" ? 1 : 0);
  }, [role, roles]);

  // Built once per card: the drag weighted by "top", the growth by "under", the rest by "waiting".
  const styles = useMemo(() => {
    const ownX = Animated.multiply(motion.x, roles.top);
    const depth = Animated.add(Animated.multiply(roles.under, Animated.subtract(1, motion.magnitude)), roles.waiting);
    return {
      place: {
        transform: [
          { translateY: depth.interpolate({ inputRange: [0, 1], outputRange: [0, UNDER_DROP] }) },
          { scale: depth.interpolate({ inputRange: [0, 1], outputRange: [1, UNDER_SCALE] }) },
        ],
      },
      drag: {
        transform: [
          { translateX: ownX },
          { translateY: Animated.multiply(motion.y, roles.top) },
          {
            rotate: ownX.interpolate({
              inputRange: [-motion.width / 2, 0, motion.width / 2],
              outputRange: [`-${String(MAX_TILT_DEG)}deg`, "0deg", `${String(MAX_TILT_DEG)}deg`],
              extrapolate: "clamp",
            }),
          },
        ],
      },
    };
  }, [motion, roles]);

  const fly = (direction: SwipeDirection, duration: number, toY?: number): void => {
    leaving.current = true;
    setMoving(true);
    const target = (direction === "right" ? 1 : -1) * width * 1.4;
    const timings = [Animated.timing(offsetX, { toValue: target, duration, easing: Easing.out(Easing.quad), useNativeDriver: true })];
    if (toY !== undefined) timings.push(Animated.timing(offsetY, { toValue: toY, duration, useNativeDriver: true }));
    Animated.parallel(timings).start(({ finished }) => {
      if (finished) onSwiped(direction);
    });
  };

  useImperativeHandle(ref, () => ({
    swipe: (direction) => {
      if (leaving.current || dragging.current || role !== "top") return;
      fly(direction, BUTTON_FLY_MS);
    },
  }));

  const onGestureEvent = useMemo(
    () =>
      Animated.event<PanGestureHandlerEventPayload>([{ nativeEvent: { translationX: dragX, translationY: dragY } }], {
        useNativeDriver: true,
        // JS only watches for the threshold, to tick the haptic; the card itself moves natively.
        listener: (event: { nativeEvent: PanGestureHandlerEventPayload }) => {
          const past = Math.abs(slopped(event.nativeEvent.translationX) + motion.rest.x) >= threshold;
          if (past === armed.current) return;
          armed.current = past;
          if (past) impactHaptic("medium");
        },
      }),
    [dragX, dragY, motion, threshold],
  );

  const onHandlerStateChange = (event: PanGestureHandlerStateChangeEvent) => {
    const { state, translationX, translationY, velocityX, velocityY } = event.nativeEvent;
    if (state === State.ACTIVE) {
      // Catch a card that is still springing back where it is.
      dragging.current = true;
      offsetX.stopAnimation((value) => {
        motion.rest.x = value;
      });
      offsetY.stopAnimation((value) => {
        motion.rest.y = value;
      });
      setMoving(true);
      return;
    }
    // A touch that never became a drag (a tap, a vertical scroll of the body) moved nothing.
    if (state !== State.END && state !== State.CANCELLED && state !== State.FAILED) return;
    if (!dragging.current || leaving.current) return;
    dragging.current = false;
    armed.current = false;
    const currentX = slopped(translationX) + motion.rest.x;
    const currentY = translationY * VERTICAL_FOLLOW + motion.rest.y;
    // Hand the position from the finger to the offsets in one batch, so the card does not move.
    offsetX.setValue(currentX);
    offsetY.setValue(currentY);
    dragX.setValue(0);
    dragY.setValue(0);
    const flung =
      Math.abs(velocityX) >= FLING_VELOCITY && Math.sign(velocityX) === Math.sign(currentX) && Math.abs(currentX) >= FLING_MIN_TRAVEL;
    if (state === State.END && (Math.abs(currentX) >= threshold || flung)) {
      // Carry the release speed into the throw so the card never slows on let-go.
      const remaining = width * 1.4 - Math.abs(currentX);
      const speed = Math.max(MIN_FLY_SPEED, Math.abs(velocityX));
      const duration = Math.min(MAX_FLY_MS, (remaining / speed) * 1000 * 1.6);
      fly(currentX > 0 ? "right" : "left", duration, currentY + velocityY * 0.05);
      return;
    }
    motion.rest = { x: 0, y: 0 };
    Animated.parallel([
      Animated.spring(offsetX, { toValue: 0, velocity: velocityX, ...SPRING, useNativeDriver: true }),
      Animated.spring(offsetY, { toValue: 0, velocity: velocityY * VERTICAL_FOLLOW, ...SPRING, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setMoving(false);
    });
  };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, layout.place, styles.place]} pointerEvents={role === "top" ? "auto" : "none"}>
      {/* eslint-disable-next-line @typescript-eslint/no-deprecated -- the legacy handler is the only one that feeds a native-driver Animated.event (Gesture.Pan() reports to JS or Reanimated only) */}
      <PanGestureHandler
        enabled={role === "top"}
        // Vertical drags belong to the card's scrolling body.
        activeOffsetX={[-ACTIVE_OFFSET, ACTIVE_OFFSET]}
        failOffsetY={[-14, 14]}
        onGestureEvent={onGestureEvent}
        onHandlerStateChange={onHandlerStateChange}
      >
        <Animated.View style={[StyleSheet.absoluteFill, styles.drag]}>
          <Animated.View style={StyleSheet.absoluteFill} shouldRasterizeIOS={role !== "top" || moving} collapsable={false}>
            {children}
          </Animated.View>
          {role === "top" && overlay?.(motion.progress)}
        </Animated.View>
      </PanGestureHandler>
    </Animated.View>
  );
}

const layout = StyleSheet.create({
  place: { transformOrigin: "bottom" },
});
