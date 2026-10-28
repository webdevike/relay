/**
 * A card you throw left, right or up. Sideways it follows the finger (tilting up to `MAX_TILT_DEG`);
 * a release past `THRESHOLD_FRACTION` of the screen width, or a fling, sends it off that side. Up
 * (only from a `SwipeUpHandle` inside the card, so the card's own scrolling keeps its vertical drags)
 * it rises without tilting, and a release past `UP_THRESHOLD_FRACTION` of the screen height, or a
 * fling, sends it off the top. Anything less springs back. Crossing a threshold ticks a haptic.
 * `swipe(direction)` (the deck's buttons) throws it the same way; `onSwiped` fires once it is off screen.
 * A throw is a spring that starts at the release speed, tilting a little further and fading as it
 * leaves, while the cards underneath each move up a level (bigger and higher). With Reduce Motion
 * the stack sits flat and a throw fades the card where it is instead.
 *
 * Every moving frame runs on React Native's native Animated driver: the pans' translations feed
 * `Animated.event(..., { useNativeDriver: true })` and the throws and spring-backs are native
 * animations, so a frame only sets transforms and opacities on the cards' own views. Reanimated would
 * commit each frame through the React shadow tree instead, and on iOS (Reanimated 4.1) that commit
 * re-rounds the whole tree's layout and makes every mounted ScrollView re-walk its subviews, so a
 * long markdown card made every frame of the drag slower.
 *
 * Only the top card moves, so a deck has one `DeckMotion` and every card is wired to it once,
 * weighted by its role (`CardRoles`: three 0/1 values and a presence): the top card follows the
 * drag, the ones underneath move up as it goes, and the action overlay shows on whichever card is
 * top natively. A throw changes those weights with `setValue`, never the animated graph, so nothing
 * is detached mid-flight and no view keeps a stale transform. The thrown card's presence drops to 0
 * on the native queue before the deck resets the motion for the next card, so whichever of that
 * reset and the React commit that unmounts it iOS shows first, it never comes back on screen
 * (`swipeDeckModel.ts` checks every frame of that hand-over).
 * The face is rasterized while it moves or waits underneath, so iOS composites one bitmap per card
 * instead of every text layer of a long body; it renders live only while it sits still on top.
 */
import { createContext, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Animated, Easing, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import {
  LongPressGestureHandler,
  PanGestureHandler,
  type LongPressGestureHandlerStateChangeEvent,
  ScrollView,
  State,
  type PanGestureHandlerEventPayload,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent,
} from "react-native-gesture-handler";
import { impactHaptic } from "@/lib/haptics";
import {
  FLY_UP,
  FLY_X,
  THRESHOLD_FRACTION,
  UP_THRESHOLD_FRACTION,
  fadeUpRange,
  fadeXRange,
  growUpRange,
  growXRange,
  horizontalRange,
  levelDropRange,
  levelScaleRange,
  tiltRange,
  upRange,
  type Range,
  type SwipeCardRole,
  type SwipeDirection,
} from "./swipeDeckModel";

/** A drag signal on the native driver: -1..1 sideways (left..right threshold), 0..1 up. */
export type SwipeProgress = Animated.AnimatedInterpolation<number>;

/** What an overlay draws from: the sideways progress and the upward progress of the top card. */
export interface SwipeSignals {
  horizontal: SwipeProgress;
  up: SwipeProgress;
}

export interface SwipeCardHandle {
  /** Throws the card off `direction`; ignored unless it is the top card and still. */
  swipe: (direction: SwipeDirection) => void;
}

/** The top card's motion, all native-driven: pans write the drags, releases animate the offsets. */
export interface DeckMotion {
  width: number;
  height: number;
  dragX: Animated.Value;
  dragY: Animated.Value;
  offsetX: Animated.Value;
  offsetY: Animated.Value;
  liftDrag: Animated.Value;
  liftOffset: Animated.Value;
  x: Animated.AnimatedAddition<number>;
  y: Animated.AnimatedAddition<number>;
  signals: SwipeSignals;
  /** How far the cards underneath have moved up a level as the top card goes, 0..1. */
  grow: SwipeProgress;
  /** How far the top card has faded on its way out, 0..1. */
  fade: SwipeProgress;
  /** Where the offsets left the card: a JS copy of what the native driver shows, added to the next pan. */
  rest: { x: number; y: number; lift: number };
}

/** One card's role as native values (1 for its role, 0 otherwise), and its presence (0 hides it whole). */
export interface CardRoles {
  top: Animated.Value;
  under: Animated.Value;
  waiting: Animated.Value;
  presence: Animated.Value;
  /** Joined the deck below the top after it was first drawn: it fades in from presence 0. */
  entering: boolean;
}

/** A pan activates after this much travel; the card starts from there, so it never jumps. */
const ACTIVE_OFFSET = 10;
/** A release this fast (pt/s) toward a side throws the card even short of the threshold. */
const FLING_VELOCITY = 900;
const FLING_MIN_TRAVEL = 30;
/** Floor speed (pt/s) a throw starts at, so a slow release still leaves briskly; a button throw starts at `BUTTON_FLY_SPEED`. */
const MIN_FLY_SPEED = 1600;
const BUTTON_FLY_SPEED = 600;
/** Loose, so the throw keeps the release's momentum and gathers speed; clamped at the target, so it ends there (~0.2-0.27 s). */
const FLY_SPRING = { stiffness: 70, damping: 8, mass: 1, overshootClamping: true } as const;
/** Reduce Motion: a throw fades the card out where it is; a card joining the back fades in. */
const FADE_MS = 220;
const APPEAR_MS = 220;
/** The card follows the finger's vertical travel at this share during a sideways drag. */
const VERTICAL_FOLLOW = 0.35;
const SPRING = { damping: 18, stiffness: 220, mass: 0.8 } as const;
const LONG_PRESS_MS = 450;
const UNIT: Range = { inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" };

/** A pan translation with the activation slop taken off, so the card starts at 0. */
function slopped(translation: number): number {
  return Math.sign(translation) * Math.max(0, Math.abs(translation) - ACTIVE_OFFSET);
}

/** `slopped` as a native interpolation: flat within the slop, slope 1 beyond it. */
function sloppedNode(value: Animated.Value): SwipeProgress {
  return value.interpolate({
    inputRange: [-ACTIVE_OFFSET - 1, -ACTIVE_OFFSET, ACTIVE_OFFSET, ACTIVE_OFFSET + 1],
    outputRange: [-1, 0, 0, 1],
    extrapolate: "extend",
  });
}

export function createDeckMotion(width: number, height: number): DeckMotion {
  const dragX = new Animated.Value(0);
  const dragY = new Animated.Value(0);
  const offsetX = new Animated.Value(0);
  const offsetY = new Animated.Value(0);
  const liftDrag = new Animated.Value(0);
  const liftOffset = new Animated.Value(0);
  const x = Animated.add(sloppedNode(dragX), offsetX);
  // Upward only: a downward pull on the handle does not move the card.
  const lift = Animated.add(
    liftDrag.interpolate({ inputRange: [-ACTIVE_OFFSET - 1, -ACTIVE_OFFSET, 0], outputRange: [-1, 0, 0], extrapolateLeft: "extend", extrapolateRight: "clamp" }),
    liftOffset,
  );
  const y = Animated.add(Animated.add(Animated.multiply(dragY, VERTICAL_FOLLOW), offsetY), lift);
  const horizontal = x.interpolate(horizontalRange(width));
  const up = lift.interpolate(upRange(height));
  // Only one of the two moves at a time, so each sum is how far the card has gone.
  const grow = Animated.add(x.interpolate(growXRange(width)), lift.interpolate(growUpRange(height))).interpolate(UNIT);
  const fade = Animated.add(x.interpolate(fadeXRange(width)), lift.interpolate(fadeUpRange(height))).interpolate(UNIT);
  return { width, height, dragX, dragY, offsetX, offsetY, liftDrag, liftOffset, x, y, signals: { horizontal, up }, grow, fade, rest: { x: 0, y: 0, lift: 0 } };
}

/** Puts the deck's motion back at rest for the next top card. */
export function resetDeckMotion(motion: DeckMotion): void {
  for (const value of [motion.dragX, motion.dragY, motion.offsetX, motion.offsetY, motion.liftDrag, motion.liftOffset]) {
    value.stopAnimation();
    value.setValue(0);
  }
  motion.rest = { x: 0, y: 0, lift: 0 };
}

export function createCardRoles(role: SwipeCardRole, entering: boolean): CardRoles {
  return {
    top: new Animated.Value(role === "top" ? 1 : 0),
    under: new Animated.Value(role === "under" ? 1 : 0),
    waiting: new Animated.Value(role === "waiting" ? 1 : 0),
    presence: new Animated.Value(entering ? 0 : 1),
    entering,
  };
}

interface SwipeUpWiring {
  enabled: boolean;
  onGestureEvent: (event: PanGestureHandlerGestureEvent) => void;
  onHandlerStateChange: (event: PanGestureHandlerStateChangeEvent) => void;
  /** The card's sideways pan, which a scroll view inside the card waits for. */
  pan: RefObject<unknown>;
  /** The card's long press, which every pan and scroll inside the card runs alongside. */
  hold: RefObject<unknown>;
}

const SwipeUpContext = createContext<SwipeUpWiring | null>(null);

/**
 * The card's sideways pan and long press, for a horizontal scroller inside a card face (a `Pager`):
 * it blocks the pan so a swipe between its pages never throws the card, and runs alongside the
 * long press. Null outside a `SwipeCard`.
 */
export function useSwipeCardGestures(): { pan: RefObject<unknown>; hold: RefObject<unknown> } | null {
  const wiring = useContext(SwipeUpContext);
  return wiring === null ? null : { pan: wiring.pan, hold: wiring.hold };
}

/**
 * The scroll view for a card face's body: it waits for the card's sideways pan to fail (the finger
 * went vertical) before it scrolls, so a sideways drag that starts on the body moves the card.
 */
export function SwipeCardScrollView({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const wiring = useContext(SwipeUpContext);
  return (
    <ScrollView style={style} showsVerticalScrollIndicator={false} {...(wiring === null ? {} : { waitFor: wiring.pan, simultaneousHandlers: wiring.hold })}>
      {children}
    </ScrollView>
  );
}

/**
 * Where an upward drag may start: wrap the parts of a card face that do not scroll (its header, a
 * body too short to scroll). Outside a `SwipeCard`, or on a card that is not on top, it is inert.
 */
export function SwipeUpHandle({ children, enabled = true, style }: { children: ReactNode; enabled?: boolean; style?: StyleProp<ViewStyle> }) {
  const wiring = useContext(SwipeUpContext);
  return (
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the legacy handler is the only one that feeds a native-driver Animated.event
    <PanGestureHandler
      enabled={enabled && wiring?.enabled === true}
      activeOffsetY={-ACTIVE_OFFSET}
      failOffsetX={[-14, 14]}
      {...(wiring === null
        ? {}
        : { onGestureEvent: wiring.onGestureEvent, onHandlerStateChange: wiring.onHandlerStateChange, simultaneousHandlers: wiring.hold })}
    >
      <Animated.View style={style} collapsable={false}>
        {children}
      </Animated.View>
    </PanGestureHandler>
  );
}

export interface SwipeCardProps {
  children: ReactNode;
  motion: DeckMotion;
  roles: CardRoles;
  role: SwipeCardRole;
  /** Whether this card may be thrown up (from its `SwipeUpHandle`s or `swipe("up")`). */
  upEnabled?: boolean | undefined;
  /** A finger held still on the top card for `LONG_PRESS_MS` (no drag, no scroll). */
  onLongPress?: (() => void) | undefined;
  onSwiped: (direction: SwipeDirection) => void;
  overlay?: ((signals: SwipeSignals) => ReactNode) | undefined;
  /** A flat stack, no tilt, and throws that fade in place. */
  reduceMotion?: boolean | undefined;
  ref?: Ref<SwipeCardHandle> | undefined;
}

export function SwipeCard({ children, motion, roles, role, upEnabled = false, onLongPress, onSwiped, overlay, reduceMotion = false, ref }: SwipeCardProps) {
  const { width, height, dragX, dragY, offsetX, offsetY, liftDrag, liftOffset } = motion;
  const threshold = width * THRESHOLD_FRACTION;
  const upThreshold = height * UP_THRESHOLD_FRACTION;
  const leaving = useRef(false);
  const dragging = useRef(false);
  const armed = useRef(false);
  const pan = useRef<unknown>(null);
  const [moving, setMoving] = useState(false);
  // A long press is its own handler, run alongside the pans and the body's scrolling (so it never
  // holds the touch from them); it fails as soon as the finger moves.
  const hold = useRef<unknown>(null);

  // Roles change by value, before the frame that shows the new deck.
  useLayoutEffect(() => {
    roles.top.setValue(role === "top" ? 1 : 0);
    roles.under.setValue(role === "under" ? 1 : 0);
    roles.waiting.setValue(role === "waiting" ? 1 : 0);
  }, [role, roles]);

  // A card that joins below the top fades in where it sits.
  useEffect(() => {
    if (roles.entering) Animated.timing(roles.presence, { toValue: 1, duration: APPEAR_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [roles]);

  // Built once per card: the drag, tilt and fade weighted by "top", the stack level by "under"
  // (one level down) and "waiting" (two), each moving up a level as the top card goes.
  const animated = useMemo(() => {
    const ownX = Animated.multiply(motion.x, roles.top);
    const level = Animated.add(
      Animated.multiply(roles.under, Animated.subtract(1, motion.grow)),
      Animated.multiply(roles.waiting, Animated.subtract(2, motion.grow)),
    );
    const tilt = tiltRange(motion.width, reduceMotion);
    return {
      place: {
        opacity: Animated.multiply(roles.presence, Animated.subtract(1, Animated.multiply(roles.top, motion.fade))),
        transform: [{ translateY: level.interpolate(levelDropRange(reduceMotion)) }, { scale: level.interpolate(levelScaleRange(reduceMotion)) }],
      },
      drag: {
        transform: [
          { translateX: ownX },
          { translateY: Animated.multiply(motion.y, roles.top) },
          { rotate: ownX.interpolate({ ...tilt, outputRange: tilt.outputRange.map((deg) => `${String(deg)}deg`) }) },
        ],
      },
      // On every card that may become top, so the commit that promotes a card never has to draw it.
      overlay: { opacity: roles.top },
    };
  }, [motion, roles, reduceMotion]);

  /** Throws the card off `direction` at `speed` (pt/s toward that side), drifting to `drift` (with its own speed) when given. */
  const fly = (direction: SwipeDirection, speed: number, drift?: { to: number; velocity: number }): void => {
    leaving.current = true;
    setMoving(true);
    const done = ({ finished }: { finished: boolean }): void => {
      if (!finished) return;
      // Hidden on the native queue ahead of the deck's reset, so neither the reset nor the commit
      // that unmounts it can draw it back where it started.
      roles.presence.setValue(0);
      onSwiped(direction);
    };
    if (reduceMotion) {
      Animated.timing(roles.presence, { toValue: 0, duration: FADE_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(done);
      return;
    }
    const sign = direction === "left" ? -1 : 1;
    const start = Math.max(MIN_FLY_SPEED, speed) * sign;
    const throwOut =
      direction === "up"
        ? Animated.spring(liftOffset, { toValue: -height * FLY_UP, velocity: -start, ...FLY_SPRING, useNativeDriver: true })
        : Animated.spring(offsetX, { toValue: sign * width * FLY_X, velocity: start, ...FLY_SPRING, useNativeDriver: true });
    // Only the throw decides when the card is gone; the drift settles on its own (the deck's reset stops it).
    if (drift !== undefined) Animated.spring(offsetY, { toValue: drift.to, velocity: drift.velocity, ...SPRING, useNativeDriver: true }).start();
    throwOut.start(done);
  };

  useImperativeHandle(ref, () => ({
    swipe: (direction) => {
      if (leaving.current || dragging.current || role !== "top" || (direction === "up" && !upEnabled)) return;
      fly(direction, BUTTON_FLY_SPEED);
    },
  }));

  /** Ticks the haptic as a drag crosses its threshold either way. */
  const watch = (past: boolean): void => {
    if (past === armed.current) return;
    armed.current = past;
    if (past) impactHaptic("medium");
  };

  /** A pan became a drag: catch a card that is still springing back where it is. */
  const pickUp = (): void => {
    dragging.current = true;
    offsetX.stopAnimation((value) => {
      motion.rest.x = value;
    });
    offsetY.stopAnimation((value) => {
      motion.rest.y = value;
    });
    liftOffset.stopAnimation((value) => {
      motion.rest.lift = value;
    });
    setMoving(true);
  };

  /** Springs every offset home after a release that did not throw, each with its own release speed. */
  const settle = (velocity: { x: number; y: number; lift: number }): void => {
    motion.rest = { x: 0, y: 0, lift: 0 };
    Animated.parallel([
      Animated.spring(offsetX, { toValue: 0, velocity: velocity.x, ...SPRING, useNativeDriver: true }),
      Animated.spring(offsetY, { toValue: 0, velocity: velocity.y, ...SPRING, useNativeDriver: true }),
      Animated.spring(liftOffset, { toValue: 0, velocity: velocity.lift, ...SPRING, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setMoving(false);
    });
  };

  const onGestureEvent = useMemo(
    () =>
      Animated.event<PanGestureHandlerEventPayload>([{ nativeEvent: { translationX: dragX, translationY: dragY } }], {
        useNativeDriver: true,
        // JS only watches for the threshold, to tick the haptic; the card itself moves natively.
        listener: (event: { nativeEvent: PanGestureHandlerEventPayload }) => {
          watch(Math.abs(slopped(event.nativeEvent.translationX) + motion.rest.x) >= threshold);
        },
      }),
    // `watch` only touches refs.
    [dragX, dragY, motion, threshold],
  );

  const onHandlerStateChange = (event: PanGestureHandlerStateChangeEvent) => {
    const { state, translationX, translationY, velocityX, velocityY } = event.nativeEvent;
    if (state === State.ACTIVE) {
      pickUp();
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
      // The throw starts at the release speed toward that side, so the card never slows on let-go.
      const side = currentX > 0 ? 1 : -1;
      fly(side > 0 ? "right" : "left", velocityX * side, { to: currentY + velocityY * 0.05, velocity: velocityY * VERTICAL_FOLLOW });
      return;
    }
    settle({ x: velocityX, y: velocityY * VERTICAL_FOLLOW, lift: 0 });
  };

  const up = useMemo<SwipeUpWiring>(() => {
    const onLiftEvent = Animated.event<PanGestureHandlerEventPayload>([{ nativeEvent: { translationY: liftDrag } }], {
      useNativeDriver: true,
      listener: (event: { nativeEvent: PanGestureHandlerEventPayload }) => {
        watch(-(Math.min(0, slopped(event.nativeEvent.translationY)) + motion.rest.lift) >= upThreshold);
      },
    });
    const onLiftState = (event: PanGestureHandlerStateChangeEvent): void => {
      const { state, translationY, velocityY } = event.nativeEvent;
      if (state === State.ACTIVE) {
        pickUp();
        return;
      }
      if (state !== State.END && state !== State.CANCELLED && state !== State.FAILED) return;
      if (!dragging.current || leaving.current) return;
      dragging.current = false;
      armed.current = false;
      const current = Math.min(0, slopped(translationY)) + motion.rest.lift;
      liftOffset.setValue(current);
      liftDrag.setValue(0);
      const flung = velocityY <= -FLING_VELOCITY && current <= -FLING_MIN_TRAVEL;
      if (state === State.END && (-current >= upThreshold || flung)) {
        fly("up", -velocityY);
        return;
      }
      settle({ x: 0, y: 0, lift: velocityY });
    };
    return {
      enabled: role === "top" && upEnabled,
      onGestureEvent: onLiftEvent,
      onHandlerStateChange: onLiftState,
      pan,
      hold,
    };
    // The handlers only read refs and the motion; they are rebuilt when the role, permission or motion setting changes.
  }, [role, upEnabled, motion, upThreshold, reduceMotion]);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, layout.place, animated.place]} pointerEvents={role === "top" ? "auto" : "none"}>
      {/* eslint-disable-next-line @typescript-eslint/no-deprecated -- the legacy handler is the only one that feeds a native-driver Animated.event (Gesture.Pan() reports to JS or Reanimated only) */}
      <PanGestureHandler
        ref={pan}
        enabled={role === "top"}
        // Vertical drags belong to the card's scrolling body and its up handles.
        activeOffsetX={[-ACTIVE_OFFSET, ACTIVE_OFFSET]}
        failOffsetY={[-14, 14]}
        onGestureEvent={onGestureEvent}
        onHandlerStateChange={onHandlerStateChange}
      >
        <Animated.View style={[StyleSheet.absoluteFill, animated.drag]}>
          <Animated.View style={StyleSheet.absoluteFill} shouldRasterizeIOS={role !== "top" || moving} collapsable={false}>
            {/* eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy, like the pans it runs alongside */}
            <LongPressGestureHandler
              ref={hold}
              enabled={role === "top" && onLongPress !== undefined}
              minDurationMs={LONG_PRESS_MS}
              simultaneousHandlers={pan}
              onHandlerStateChange={(event: LongPressGestureHandlerStateChangeEvent) => {
                if (event.nativeEvent.state !== State.ACTIVE || leaving.current || dragging.current) return;
                impactHaptic("medium");
                onLongPress?.();
              }}
            >
              <Animated.View style={StyleSheet.absoluteFill} collapsable={false}>
                <SwipeUpContext.Provider value={up}>{children}</SwipeUpContext.Provider>
              </Animated.View>
            </LongPressGestureHandler>
          </Animated.View>
          {role !== "waiting" && overlay !== undefined && (
            <Animated.View style={[StyleSheet.absoluteFill, animated.overlay]} pointerEvents="none">
              {overlay(motion.signals)}
            </Animated.View>
          )}
        </Animated.View>
      </PanGestureHandler>
    </Animated.View>
  );
}

const layout = StyleSheet.create({
  place: { transformOrigin: "bottom" },
});
