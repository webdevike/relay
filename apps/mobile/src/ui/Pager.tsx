import { createContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, View, type ScrollViewProps } from "react-native";
import { Gesture, GestureDetector, ScrollView as GestureScrollView, type NativeGesture } from "react-native-gesture-handler";
import { tapHaptic } from "@/lib/haptics";
import { useSwipeCardGestures } from "@/ui/SwipeCard";

/** The scroll gesture of the `Pager` with `nests` around a `NestedPager`, which it waits on. */
export const OuterPagerContext = createContext<NativeGesture | null>(null);

/** Page state for a `Pager`: `go` clamps to the valid range, skips no-op moves, and plays a tap haptic. */
export function usePager(
  count: number,
  initial = 0,
): { page: number; setPage: (page: number) => void; go: (next: number) => void } {
  const [page, setPage] = useState(initial);
  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(count - 1, next));
    if (clamped === page) return;
    tapHaptic();
    setPage(clamped);
  };
  return { page, setPage, go };
}

export interface PagerProps {
  width: number;
  page: number;
  onPageChange: (page: number) => void;
  scrollEnabled?: boolean | undefined;
  /** Size the pager to the current page's own height instead of the tallest page's (tab panes of
   * different lengths); the height follows once a swipe or tap settles. */
  fitPage?: boolean | undefined;
  /** Its pages hold `NestedPager`s (Home's widget stacks): a sideways swipe that starts on one waits
   * for that pager to decide, and only the ones it hands back (past its first or last page) turn
   * this pager. */
  nests?: boolean | undefined;
  children: ReactNode[];
}

/** Horizontal one-page-at-a-time scroller. Controlled by `page`: programmatic changes animate,
 * a width change (rotation) re-aligns instantly, and swipes report back through `onPageChange`
 * without triggering a redundant scroll. Inside a Catch Up `SwipeCard` it blocks the card's
 * sideways pan, so swiping between pages never throws the card; vertical drags still fall through
 * to the scroll around it. With `nests`, a `NestedPager` inside gets first say over sideways swipes. */
export function Pager({ width, page, onPageChange, scrollEnabled, fitPage, nests, children }: PagerProps) {
  const scroller = useRef<ScrollView>(null);
  const card = useSwipeCardGestures();
  const native = useMemo(() => Gesture.Native(), []);
  // The page and width the scroll view is currently resting at, so effects only scroll on real drift.
  const settledPage = useRef(page);
  const settledWidth = useRef(width);
  const [heights, setHeights] = useState<readonly number[]>([]);

  useEffect(() => {
    if (width <= 0) return;
    const widthChanged = width !== settledWidth.current;
    if (!widthChanged && page === settledPage.current) return;
    settledPage.current = page;
    settledWidth.current = width;
    scroller.current?.scrollTo({ x: page * width, animated: !widthChanged });
  }, [page, width]);

  if (width <= 0) return null;

  const height = fitPage === true ? heights[page] : undefined;
  const props = {
    horizontal: true,
    pagingEnabled: true,
    nestedScrollEnabled: true,
    showsHorizontalScrollIndicator: false,
    scrollEnabled: scrollEnabled ?? true,
    contentOffset: { x: page * width, y: 0 },
    // Pages keep their own height (not stretched to the tallest) so each can be measured.
    ...(fitPage === true ? { style: height === undefined ? undefined : { height }, contentContainerStyle: { alignItems: "flex-start" } } : {}),
    onMomentumScrollEnd: (e) => {
      const next = Math.round(e.nativeEvent.contentOffset.x / width);
      settledPage.current = next;
      if (next !== page) onPageChange(next);
    },
  } satisfies ScrollViewProps;
  const pages = children.map((child, i) => (
    <View
      key={i}
      style={{ width }}
      onLayout={
        fitPage === true
          ? (e) => {
              const measured = e.nativeEvent.layout.height;
              setHeights((current) => {
                if (current[i] === measured) return current;
                const next = [...current];
                next[i] = measured;
                return next;
              });
            }
          : undefined
      }
    >
      {child}
    </View>
  ));

  if (card !== null) {
    return (
      <GestureScrollView ref={scroller} blocksHandlers={card.pan} simultaneousHandlers={card.hold} {...props}>
        {pages}
      </GestureScrollView>
    );
  }
  if (nests === true) {
    return (
      <OuterPagerContext.Provider value={native}>
        <GestureDetector gesture={native}>
          <ScrollView ref={scroller} {...props}>
            {pages}
          </ScrollView>
        </GestureDetector>
      </OuterPagerContext.Provider>
    );
  }
  return (
    <ScrollView ref={scroller} {...props}>
      {pages}
    </ScrollView>
  );
}
