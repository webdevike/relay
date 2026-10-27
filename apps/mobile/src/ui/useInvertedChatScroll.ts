import { useCallback, useEffect, useRef, useState } from "react";
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

const BOTTOM_THRESHOLD = 24;
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
    },
  };
}
