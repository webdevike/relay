/**
 * The card stack opened over the screen (Relay ask cards, Isaac 2026-11-24): the cards rise from
 * the composer to the middle of the screen over a scrim, one in front and its neighbours peeking in
 * from the sides, faded and a touch smaller. A sideways swipe moves one card and loops (past the
 * last comes the first); a tap on a side card brings it to the front; a swipe down or a tap outside
 * collapses it. A card that leaves while it is open lifts away (answered here) or fades (resolved
 * elsewhere). It rides up by half the keyboard, so a typed answer stays in view.
 *
 * The caller mounts it only while open (its rise and fall are the entering and exiting
 * animations) and owns which card is in front: `onStep` and `onShow` report moves, which the
 * carousel has already drawn. Gesture math lives in `carouselMath.ts`. Values from the ask-cards
 * prototype (`mobile.tsx`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type EntryExitAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { keyboardHeight } from "@/lib/keyboardMotion";
import { useCoversContent } from "./covering";
import { CARD_GAP, carouselCardWidth, carouselOwner, carouselRelease, loopSlot, sideness, SIDE_OPACITY, SIDE_SCALE, slotFrame, type SlotFrame } from "./carouselMath";

const SPRING = { stiffness: 380, damping: 38, mass: 1, reduceMotion: ReduceMotion.System } as const;
/** Room the open card leaves above and below it (the prototype's `100dvh - 190px`). */
const SCREEN_MARGIN = 190;
/** Where the cards rise from and sink back to. */
const RISE_Y = 260;
const RISE_SCALE = 0.7;

const rise: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: RISE_Y }, { scale: RISE_SCALE }] },
    animations: {
      opacity: withSpring(1, SPRING),
      transform: [{ translateY: withSpring(0, SPRING) }, { scale: withSpring(1, SPRING) }],
    },
  };
};
const sink: EntryExitAnimationFunction = () => {
  "worklet";
  const fall = { duration: 200, reduceMotion: ReduceMotion.System };
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
    animations: {
      opacity: withTiming(0, fall),
      transform: [{ translateY: withTiming(RISE_Y, fall) }, { scale: withTiming(RISE_SCALE, fall) }],
    },
  };
};
/** Answered here: the card lifts up and away. */
const lift: EntryExitAnimationFunction = () => {
  "worklet";
  const out = { duration: 280, reduceMotion: ReduceMotion.System };
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
    animations: { opacity: withTiming(0, out), transform: [{ translateY: withTiming(-28, out) }, { scale: withTiming(0.97, out) }] },
  };
};
/** Resolved elsewhere (in the chat, on another device): the card fades as it shrinks. */
const fade: EntryExitAnimationFunction = () => {
  "worklet";
  const out = { duration: 350, reduceMotion: ReduceMotion.System };
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
    animations: { opacity: withTiming(0, out), transform: [{ translateY: withTiming(-10, out) }, { scale: withTiming(0.9, out) }] },
  };
};
const SCRIM_IN = FadeIn.duration(250).reduceMotion(ReduceMotion.System);
const SCRIM_OUT = FadeOut.delay(50).duration(200).reduceMotion(ReduceMotion.System);

export interface CarouselCard {
  key: string;
  /** How it leaves if it goes while open: `lift` when Isaac answered it here, else `fade`. */
  exit: "lift" | "fade";
  /** VoiceOver label of the card while it is a side card ("Show <title>"). */
  label: string;
  /** The card, at most `maxHeight` tall. */
  content: (maxHeight: number) => ReactNode;
}

export interface CardCarouselProps {
  cards: readonly CarouselCard[];
  /** Index of the card in front. */
  front: number;
  /** A swipe moved one card (1 next, -1 previous). */
  onStep: (by: 1 | -1) => void;
  /** A tapped side card came to the front. */
  onShow: (index: number) => void;
  onCollapse: () => void;
}

export function CardCarousel({ cards, front, onStep, onShow, onCollapse }: CardCarouselProps) {
  useCoversContent(true);
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const width = carouselCardWidth(window.width);
  const step = width + CARD_GAP;
  const count = cards.length;
  const maxHeight = window.height - SCREEN_MARGIN;
  // The front card on the UI thread: a swipe moves it there the same frame it shifts the strip, so
  // no card jumps while React catches up. Moves from outside (a card left) set it here.
  const frontAt = useSharedValue(front);
  useEffect(() => {
    frontAt.value = front;
  }, [front, frontAt]);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const decided = useSharedValue(false);
  /** 1 while the swipe runs sideways, 2 while it runs down. */
  const axis = useSharedValue(0);

  // Stable bridges into React for the worklets: the latest callbacks, never a new gesture per render.
  const latest = useRef({ onStep, onShow, onCollapse });
  latest.current = { onStep, onShow, onCollapse };
  const stepped = useCallback((by: 1 | -1) => {
    latest.current.onStep(by);
  }, []);
  const collapse = useCallback(() => {
    latest.current.onCollapse();
  }, []);

  /** Brings card `index` to the front: the strip keeps where every card is drawn, then springs home. */
  const show = useCallback(
    (index: number) => {
      scheduleOnUI(() => {
        "worklet";
        const delta = loopSlot(index, frontAt.value, count);
        if (delta === 0) return;
        frontAt.value = index;
        x.value = x.value + delta * step;
        x.value = withSpring(0, SPRING);
      });
      latest.current.onShow(index);
    },
    [count, step, frontAt, x],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .maxPointers(1)
        .onTouchesDown((event) => {
          const touch = event.allTouches[0];
          if (touch === undefined) return;
          startX.value = touch.absoluteX;
          startY.value = touch.absoluteY;
          decided.value = false;
          axis.value = 0;
        })
        .onTouchesMove((event, manager) => {
          const touch = event.allTouches[0];
          if (decided.value || touch === undefined) return;
          const dx = touch.absoluteX - startX.value;
          const dy = touch.absoluteY - startY.value;
          const owner = carouselOwner(dx, dy);
          if (owner === "undecided") return;
          decided.value = true;
          if (owner === "none") {
            manager.fail();
            return;
          }
          axis.value = Math.abs(dx) > Math.abs(dy) ? 1 : 2;
          manager.activate();
        })
        .onUpdate((event) => {
          if (axis.value === 1) x.value = count > 1 ? event.translationX : event.translationX * 0.25;
          else if (axis.value === 2) y.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
          const sideways = axis.value === 1;
          const action = carouselRelease(sideways ? event.translationX : 0, sideways ? 0 : event.translationY, sideways ? event.velocityX : 0, sideways ? 0 : event.velocityY);
          if (action === "collapse") {
            scheduleOnRN(collapse);
            return;
          }
          y.value = withSpring(0, SPRING);
          if (action !== 0 && count > 1) {
            const to = (((frontAt.value + action) % count) + count) % count;
            const delta = loopSlot(to, frontAt.value, count);
            frontAt.value = to;
            x.value = x.value + delta * step;
            scheduleOnRN(stepped, action);
          }
          x.value = withSpring(0, SPRING);
        }),
    [count, step, collapse, stepped, frontAt, x, y, startX, startY, decided, axis],
  );

  // The tallest card sets the strip's height; every card is centred on it.
  const [heights, setHeights] = useState<Readonly<Record<string, number>>>({});
  const tallest = Math.min(maxHeight, Math.max(0, ...cards.map((card) => heights[card.key] ?? 0)));

  const stageStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -keyboardHeight.value / 2 + y.value }] }));

  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Animated.View entering={SCRIM_IN} exiting={SCRIM_OUT} style={[StyleSheet.absoluteFill, styles.scrim]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close cards" onPress={onCollapse} />
      </Animated.View>
      <View pointerEvents="box-none" style={styles.center}>
        <Animated.View entering={reduced ? SCRIM_IN : rise} exiting={reduced ? SCRIM_OUT : sink} pointerEvents="box-none" style={styles.stageWrap}>
          <Animated.View pointerEvents="box-none" style={stageStyle}>
            <GestureDetector gesture={pan}>
              <View pointerEvents="box-none" style={[styles.strip, { height: tallest }]}>
                {/* Cards that leave while it stays open animate out; closing the carousel takes them all at once. */}
                <LayoutAnimationConfig skipExiting skipEntering>
                  {cards.map((card, index) => (
                    <Slot
                      key={card.key}
                      card={card}
                      index={index}
                      count={count}
                      step={step}
                      frame={slotFrame((window.width - width) / 2, width, tallest, heights[card.key] ?? 0)}
                      maxHeight={maxHeight}
                      isFront={index === front}
                      frontAt={frontAt}
                      x={x}
                      onShow={show}
                      onHeight={(height) => {
                        setHeights((current) => (current[card.key] === height ? current : { ...current, [card.key]: height }));
                      }}
                    />
                  ))}
                </LayoutAnimationConfig>
              </View>
            </GestureDetector>
          </Animated.View>
        </Animated.View>
      </View>
    </View>
  );
}

function Slot({
  card,
  index,
  count,
  step,
  frame,
  maxHeight,
  isFront,
  frontAt,
  x,
  onShow,
  onHeight,
}: {
  card: CarouselCard;
  index: number;
  count: number;
  step: number;
  frame: SlotFrame;
  maxHeight: number;
  isFront: boolean;
  frontAt: SharedValue<number>;
  x: SharedValue<number>;
  onShow: (index: number) => void;
  onHeight: (height: number) => void;
}) {
  const place = useAnimatedStyle(() => {
    const offset = loopSlot(index, frontAt.value, count) * step + x.value;
    const side = sideness(offset, step);
    return {
      opacity: 1 - (1 - SIDE_OPACITY) * side,
      transform: [{ translateX: offset }, { scale: 1 - (1 - SIDE_SCALE) * side }],
    };
  });
  return (
    <Animated.View exiting={card.exit === "lift" ? lift : fade} pointerEvents="box-none" style={frame}>
      <Animated.View style={place}>
        <View
          onLayout={(event) => {
            onHeight(Math.round(event.nativeEvent.layout.height));
          }}
          pointerEvents={isFront ? "auto" : "none"}
          accessibilityElementsHidden={!isFront}
          importantForAccessibility={isFront ? "auto" : "no-hide-descendants"}
        >
          {card.content(maxHeight)}
        </View>
        {!isFront && (
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={card.label}
            onPress={() => {
              onShow(index);
            }}
          />
        )}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: "rgba(0,0,0,0.4)" },
  center: { ...StyleSheet.absoluteFillObject, justifyContent: "center" },
  stageWrap: { width: "100%" },
  strip: { width: "100%" },
});
