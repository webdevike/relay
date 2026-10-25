/**
 * A stack of swipeable cards: the first item is a `SwipeCard` on top, the second waits underneath,
 * a little smaller with its bottom edge peeking out, and grows into place as the top card is dragged
 * away. When the top card leaves, `onSwipe` reports it (the caller drops or reorders the item) and
 * the next settles in. `swipe(direction)` throws the top card, for buttons beside the deck.
 */
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { motion } from "@/theme";
import { SwipeCard, type SwipeCardHandle, type SwipeDirection } from "./SwipeCard";

export interface SwipeDeckHandle {
  swipe: (direction: SwipeDirection) => void;
}

export interface SwipeDeckProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  renderCard: (item: T) => ReactNode;
  /** Drawn over the top card with its signed drag progress (-1 left .. 1 right). */
  renderOverlay?: (progress: SharedValue<number>) => ReactNode;
  onSwipe: (item: T, direction: SwipeDirection) => void;
  ref?: Ref<SwipeDeckHandle>;
}

/** The waiting card's scale before the top one moves; it shrinks toward its bottom edge. */
const UNDER_SCALE = 0.94;
/** How much of the waiting card peeks out below the top one; leave this much room under the deck. */
export const UNDER_DROP = 12;

export function SwipeDeck<T>({ items, keyOf, renderCard, renderOverlay, onSwipe, ref }: SwipeDeckProps<T>) {
  const top = items[0];
  const under = items[1];
  // How far the top card has gone toward leaving (0..1); the waiting card follows it.
  const stack = useSharedValue(0);
  const card = useRef<SwipeCardHandle>(null);
  // A card kept for later can come straight back on top (the last one left): a new key per throw
  // remounts the top card, so it never reappears from where it was thrown.
  const [throws, setThrows] = useState(0);
  const topKey = top === undefined ? null : keyOf(top);

  useEffect(() => {
    stack.value = withTiming(0, { duration: motion.duration.base });
  }, [topKey, throws, stack]);

  useImperativeHandle(ref, () => ({ swipe: (direction) => card.current?.swipe(direction) }), []);

  const underStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: UNDER_DROP * (1 - stack.value) }, { scale: UNDER_SCALE + (1 - UNDER_SCALE) * stack.value }],
  }));

  return (
    <View style={styles.root}>
      {under !== undefined && (
        <Animated.View key={keyOf(under)} style={[StyleSheet.absoluteFill, styles.under, underStyle]} pointerEvents="none">
          {renderCard(under)}
        </Animated.View>
      )}
      {top !== undefined && (
        <SwipeCard
          key={`${keyOf(top)}:${String(throws)}`}
          ref={card}
          stack={stack}
          overlay={renderOverlay}
          onSwiped={(direction) => {
            setThrows((n) => n + 1);
            onSwipe(top, direction);
          }}
        >
          {renderCard(top)}
        </SwipeCard>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  under: { transformOrigin: "bottom" },
});
