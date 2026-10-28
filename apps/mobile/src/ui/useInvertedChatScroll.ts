import { createElement, useCallback, useEffect, useRef, useState, type Ref } from "react";
import { ScrollView, StyleSheet, View, type FlatList, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

const BOTTOM_THRESHOLD = 24;
/**
 * Native anchoring keeps a reader's rows still while the transcript grows under them. A follower
 * needs none: at offset 0 the inverted list already grows upward from the newest row. Anchoring a
 * follower to a row moved the offset off 0 on every new or growing row (the newest rows and the
 * activity row dropped below the fold) until the next frame scrolled back, so rows anchor only
 * while away.
 */
const ANCHOR = { minIndexForVisible: 1 } as const;
/**
 * The follower anchors to a pin instead of turning anchoring off: iOS picks its anchor only while
 * anchoring is on, so switching it back on measured against the row picked when it went off, and
 * the list jumped by everything that had arrived since (the release jump after a small drag up).
 * The pin is the content view's first subview, spans it from offset 0 and never moves, so
 * anchoring to it changes nothing.
 */
const FOLLOW = { minIndexForVisible: 0 } as const;
const pin = createElement(View, { collapsable: false, pointerEvents: "none", style: StyleSheet.absoluteFill });

function PinnedScrollView({ maintainVisibleContentPosition: anchor, stickyHeaderIndices, children, ...props }: ScrollViewProps & { ref?: Ref<ScrollView> }) {
  return createElement(ScrollView, {
    ...props,
    // The pin shifts every child index the list computed by one.
    maintainVisibleContentPosition: anchor ? { ...anchor, minIndexForVisible: anchor.minIndexForVisible + 1 } : FOLLOW,
    stickyHeaderIndices: stickyHeaderIndices?.map((index) => index + 1),
  }, pin, children);
}

const renderScrollComponent = (props: ScrollViewProps) => createElement(PinnedScrollView, props);
type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/** Inverted transcripts share one rule: only a reader gesture can suspend following. */
export function useInvertedChatScroll<T>({ initialOffset = 0, onOffset }: { initialOffset?: number; onOffset?: (offset: number) => void } = {}) {
  const listRef = useRef<FlatList<T>>(null);
  const offsetRef = useRef(initialOffset);
  const following = useRef(initialOffset <= BOTTOM_THRESHOLD);
  const dragging = useRef(false);
  const scrollingToBottom = useRef(false);
  const frame = useRef<number | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(initialOffset > BOTTOM_THRESHOLD);
  const reducedMotion = useReducedMotion();

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const followContent = useCallback(() => {
    if (!following.current || dragging.current || scrollingToBottom.current) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (following.current && !dragging.current && !scrollingToBottom.current) {
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      }
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    following.current = true;
    dragging.current = false;
    scrollingToBottom.current = !reducedMotion;
    setAwayFromBottom(false);
    listRef.current?.scrollToOffset({ offset: 0, animated: !reducedMotion });
  }, [reducedMotion]);

  const observeScroll = (event: ScrollEvent): void => {
    const offset = Math.max(0, event.nativeEvent.contentOffset.y);
    offsetRef.current = offset;
    onOffset?.(offset);
    // Native anchoring moves offsets too. It must not unpin a reader who was following.
    if (!dragging.current) return;
    const near = offset <= BOTTOM_THRESHOLD;
    following.current = near;
    setAwayFromBottom(!near);
  };

  return {
    listRef, offsetRef, awayFromBottom, scrollToBottom, followContent,
    scrollHandlers: {
      onContentSizeChange: followContent,
      onScroll: observeScroll,
      onScrollBeginDrag: () => { scrollingToBottom.current = false; dragging.current = true; },
      onScrollEndDrag: (event: ScrollEvent) => { observeScroll(event); dragging.current = false; },
      onMomentumScrollBegin: () => { if (!scrollingToBottom.current) dragging.current = true; },
      onMomentumScrollEnd: (event: ScrollEvent) => {
        if (!scrollingToBottom.current) observeScroll(event);
        scrollingToBottom.current = false;
        dragging.current = false;
        followContent();
      },
      scrollEventThrottle: 16,
      maintainVisibleContentPosition: awayFromBottom ? ANCHOR : null,
      renderScrollComponent,
    },
  };
}
