/**
 * A stack of swipeable cards: the first item is the `SwipeCard` on top, the next two wait
 * underneath, each a little smaller with its bottom edge peeking out below the one above, and move
 * up a level as the top card is dragged away. When the top card leaves, `onSwipe` reports it (the
 * caller drops or reorders the item). `swipe(direction)` throws the top card, for buttons beside the
 * deck. Leave `STACK_DROP` of room under the deck for the peeking edges.
 *
 * Each card keeps one mounted `SwipeCard` (keyed by item) for as long as it is in the first
 * `SLOTS`, so its face is rendered and drawn once, while it waits; a throw only changes the cards'
 * role values. (Remounting the next two cards on every throw rebuilt and redrew two long markdown
 * bodies right as the next card should take the finger.) The card that joins at the back mounts
 * `PRELOAD_DELAY_MS` later, after the deck has settled, so its first render never lands on a throw,
 * and fades in.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type Ref } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { SwipeCard, createCardRoles, createDeckMotion, resetDeckMotion, type CardRoles, type DeckMotion, type SwipeCardHandle, type SwipeSignals } from "./SwipeCard";
import { SLOTS, deckSlots, type SwipeCardRole, type SwipeDirection } from "./swipeDeckModel";

export interface SwipeDeckHandle {
  swipe: (direction: SwipeDirection) => void;
}

export interface SwipeDeckProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** Called again on every deck render for cards that are already mounted: memoize the face. */
  renderCard: (item: T) => ReactNode;
  /** Drawn over the top card from its drag signals (sideways -1..1, up 0..1). */
  renderOverlay?: (signals: SwipeSignals) => ReactNode;
  /** Whether `item` can be thrown up; off by default. */
  canSwipeUp?: (item: T) => boolean;
  /** A finger held still on the top card. */
  onLongPress?: (item: T) => void;
  onSwipe: (item: T, direction: SwipeDirection) => void;
  ref?: Ref<SwipeDeckHandle>;
}

const PRELOAD_DELAY_MS = 350;

export function SwipeDeck<T>({ items, keyOf, renderCard, renderOverlay, canSwipeUp, onLongPress, onSwipe, ref }: SwipeDeckProps<T>) {
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const [motion, setMotion] = useState<DeckMotion>(() => createDeckMotion(width, height));
  if (motion.width !== width || motion.height !== height) setMotion(createDeckMotion(width, height));
  const roles = useRef(new Map<string, CardRoles>());
  const top = useRef<SwipeCardHandle>(null);
  // Throws per item, so a card thrown and put back (Keep Unread on the last cards) comes back fresh,
  // under a new key. A ref, so whichever render follows the throw (the caller's store update may
  // render before this deck's own) already has it.
  const throws = useRef<Record<string, number>>({});
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  // Cards that join after the first render fade in below the top.
  const drawn = useRef(false);
  const slots = deckSlots(items, keyOf, throws.current);
  const keys = slots.map((slot) => slot.key);
  const back = slots.length === SLOTS ? keys[SLOTS - 1] : undefined;
  const [preloaded, setPreloaded] = useState<string | undefined>(undefined);

  useEffect(() => {
    drawn.current = true;
  }, []);

  useEffect(() => {
    if (back === undefined) return;
    const timer = setTimeout(() => {
      setPreloaded(back);
    }, PRELOAD_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [back]);

  // A new top card starts from rest. Runs after the cards' own layout effects have set their roles,
  // so the roles and the reset go out in one native batch (the thrown card is already hidden).
  const topKey = keys[0];
  useLayoutEffect(() => {
    resetDeckMotion(motion);
  }, [topKey, motion]);

  const joined = keys.join("\n");
  useEffect(() => {
    const live = joined.split("\n");
    for (const key of roles.current.keys()) if (!live.includes(key)) roles.current.delete(key);
  }, [joined]);

  useImperativeHandle(ref, () => ({ swipe: (direction) => top.current?.swipe(direction) }), []);

  const rolesOf = (key: string, role: SwipeCardRole): CardRoles => {
    const existing = roles.current.get(key);
    if (existing !== undefined) return existing;
    const created = createCardRoles(role, role !== "top" && (drawn.current || role === "waiting"));
    roles.current.set(key, created);
    return created;
  };
  const shown = slots.filter((slot, index) => index < SLOTS - 1 || slot.key === preloaded);

  return (
    <View style={styles.root}>
      {shown
        .map(({ item, key, role }, index) => (
          <SwipeCard
            key={key}
            ref={index === 0 ? top : undefined}
            motion={motion}
            roles={rolesOf(key, role)}
            role={role}
            reduceMotion={reduceMotion}
            upEnabled={canSwipeUp?.(item) ?? false}
            onLongPress={
              onLongPress === undefined
                ? undefined
                : () => {
                    onLongPress(item);
                  }
            }
            overlay={renderOverlay}
            onSwiped={(direction) => {
              const id = keyOf(item);
              throws.current = { ...throws.current, [id]: (throws.current[id] ?? 0) + 1 };
              rerender();
              onSwipe(item, direction);
            }}
          >
            {renderCard(item)}
          </SwipeCard>
        ))
        // The top card renders last, so it is on top.
        .reverse()}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
