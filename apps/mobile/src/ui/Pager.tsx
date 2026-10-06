import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { tapHaptic } from "@/lib/haptics";

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
  children: ReactNode[];
}

/** Horizontal one-page-at-a-time scroller. Controlled by `page`: programmatic changes animate,
 * a width change (rotation) re-aligns instantly, and swipes report back through `onPageChange`
 * without triggering a redundant scroll. */
export function Pager({ width, page, onPageChange, scrollEnabled, children }: PagerProps) {
  const scroller = useRef<ScrollView>(null);
  // The page and width the scroll view is currently resting at, so effects only scroll on real drift.
  const settledPage = useRef(page);
  const settledWidth = useRef(width);

  useEffect(() => {
    if (width <= 0) return;
    const widthChanged = width !== settledWidth.current;
    if (!widthChanged && page === settledPage.current) return;
    settledPage.current = page;
    settledWidth.current = width;
    scroller.current?.scrollTo({ x: page * width, animated: !widthChanged });
  }, [page, width]);

  if (width <= 0) return null;

  return (
    <ScrollView
      ref={scroller}
      horizontal
      pagingEnabled
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      scrollEnabled={scrollEnabled ?? true}
      contentOffset={{ x: page * width, y: 0 }}
      onMomentumScrollEnd={(e) => {
        const next = Math.round(e.nativeEvent.contentOffset.x / width);
        settledPage.current = next;
        if (next !== page) onPageChange(next);
      }}
    >
      {children.map((child, i) => (
        <View key={i} style={{ width }}>
          {child}
        </View>
      ))}
    </ScrollView>
  );
}
