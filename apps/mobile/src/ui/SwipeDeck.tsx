/**
 * A stack of swipeable cards: the first item is the `SwipeCard` on top, the second waits underneath,
 * a little smaller with its bottom edge peeking out, and grows into place as the top card is dragged
 * away. When the top card leaves, `onSwipe` reports it (the caller drops or reorders the item).
 * `swipe(direction)` throws the top card, for buttons beside the deck.
 *
 * Each card keeps one mounted `SwipeCard` (keyed by item) for as long as it is in the first
 * `SLOTS`, so its face is rendered and drawn once, while it waits; a throw only changes the cards'
 * role values. (Remounting the next two cards on every throw rebuilt and redrew two long markdown
 * bodies right as the next card should take the finger.) The card that joins at the back mounts
 * `PRELOAD_DELAY_MS` later, after the deck has settled, so its first render never lands on a throw.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import {
  SwipeCard,
  createCardRoles,
  createDeckMotion,
  resetDeckMotion,
  type CardRoles,
  type DeckMotion,
  type SwipeCardHandle,
  type SwipeCardRole,
  type SwipeDirection,
  type SwipeProgress,
} from "./SwipeCard";

export { UNDER_DROP } from "./SwipeCard";

export interface SwipeDeckHandle {
  swipe: (direction: SwipeDirection) => void;
}

export interface SwipeDeckProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** Called again on every deck render for cards that are already mounted: memoize the face. */
  renderCard: (item: T) => ReactNode;
  /** Drawn over the top card with its signed drag progress (-1 left .. 1 right). */
  renderOverlay?: (progress: SwipeProgress) => ReactNode;
  onSwipe: (item: T, direction: SwipeDirection) => void;
  ref?: Ref<SwipeDeckHandle>;
}

/** Cards kept mounted: the top one, the one underneath, and the next, ready behind it. */
const SLOTS = 3;
const PRELOAD_DELAY_MS = 350;
const ROLES: readonly SwipeCardRole[] = ["top", "under", "waiting"];

export function SwipeDeck<T>({ items, keyOf, renderCard, renderOverlay, onSwipe, ref }: SwipeDeckProps<T>) {
  const { width } = useWindowDimensions();
  const [motion, setMotion] = useState<DeckMotion>(() => createDeckMotion(width));
  if (motion.width !== width) setMotion(createDeckMotion(width));
  const roles = useRef(new Map<string, CardRoles>());
  const top = useRef<SwipeCardHandle>(null);
  // A card thrown and then put back (Keep Unread on the last cards) comes back fresh, under a new key.
  const [generation, setGeneration] = useState<Record<string, number>>({});
  const slots = items.slice(0, SLOTS);
  const keys = slots.map((item) => `${keyOf(item)}:${String(generation[keyOf(item)] ?? 0)}`);
  const back = slots.length === SLOTS ? keys[SLOTS - 1] : undefined;
  const [preloaded, setPreloaded] = useState<string | undefined>(undefined);

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
  // in the same frame, so the thrown card is gone and the next one is full size before this moves.
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
    const created = createCardRoles(role);
    roles.current.set(key, created);
    return created;
  };
  const shown = slots.filter((_, index) => index < SLOTS - 1 || keys[index] === preloaded);

  return (
    <View style={styles.root}>
      {shown
        .map((item, index) => {
          const key = keys[index] ?? "";
          const role = ROLES[index] ?? "waiting";
          return (
            <SwipeCard
              key={key}
              ref={index === 0 ? top : undefined}
              motion={motion}
              roles={rolesOf(key, role)}
              role={role}
              overlay={renderOverlay}
              onSwiped={(direction) => {
                const id = keyOf(item);
                setGeneration((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
                onSwipe(item, direction);
              }}
            >
              {renderCard(item)}
            </SwipeCard>
          );
        })
        // The top card renders last, so it is on top.
        .reverse()}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
