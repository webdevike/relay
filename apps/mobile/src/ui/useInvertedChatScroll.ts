import { createElement, useCallback, useEffect, useRef, type Ref } from "react";
import { ScrollView, StyleSheet, View, type FlatList, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useActorRef, useSelector } from "@xstate/react";
import { awayFromBottom as selectAway, chatFollowMachine } from "./chatFollow.machine";

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

/** Inverted transcripts share one rule: only a reader gesture can suspend following (`chatFollow.machine.ts`). */
export function useInvertedChatScroll<T>({ initialOffset = 0, onOffset }: { initialOffset?: number; onOffset?: (offset: number) => void } = {}) {
  const listRef = useRef<FlatList<T>>(null);
  const offsetRef = useRef(initialOffset);
  const frame = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const follow = useActorRef(
    chatFollowMachine.provide({
      actions: {
        followNewest: ({ self }) => {
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (self.getSnapshot().matches("following")) listRef.current?.scrollToOffset({ offset: 0, animated: false });
          });
        },
        scrollHome: ({ event }) => {
          if (event.type === "follow.toBottom") listRef.current?.scrollToOffset({ offset: 0, animated: event.animated });
        },
        centreRow: ({ event }) => {
          if (event.type === "follow.toRow") listRef.current?.scrollToIndex({ index: event.index, viewPosition: 0.5, animated: event.animated });
        },
      },
    }),
    { input: { initialOffset } },
  );
  const awayFromBottom = useSelector(follow, selectAway);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const followContent = useCallback(() => {
    follow.send({ type: "follow.contentChanged" });
  }, [follow]);

  const scrollToBottom = useCallback(() => {
    follow.send({ type: "follow.toBottom", animated: !reducedMotion });
  }, [follow, reducedMotion]);

  /** Scrolls row `index` to the middle of the list, smoothly, and stops following the newest row. */
  const scrollToRow = useCallback((index: number) => {
    follow.send({ type: "follow.toRow", index, animated: !reducedMotion });
  }, [follow, reducedMotion]);

  const onScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    listRef.current?.scrollToOffset({ offset: info.index * info.averageItemLength, animated: false });
    const centred = follow.getSnapshot().context.target === info.index;
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index: info.index, viewPosition: centred ? 0.5 : 1, animated: false });
    }, 80);
  }, [follow]);

  const observe = (event: ScrollEvent): number => {
    const offset = Math.max(0, event.nativeEvent.contentOffset.y);
    offsetRef.current = offset;
    onOffset?.(offset);
    return offset;
  };

  return {
    listRef, offsetRef, awayFromBottom, scrollToBottom, scrollToRow, followContent,
    scrollHandlers: {
      onScrollToIndexFailed,
      onContentSizeChange: followContent,
      onScroll: (event: ScrollEvent) => { follow.send({ type: "follow.scroll", offset: observe(event) }); },
      onScrollBeginDrag: () => { follow.send({ type: "follow.dragStart" }); },
      onScrollEndDrag: (event: ScrollEvent) => { follow.send({ type: "follow.dragEnd", offset: observe(event) }); },
      onMomentumScrollBegin: () => { follow.send({ type: "follow.momentumStart" }); },
      onMomentumScrollEnd: (event: ScrollEvent) => { follow.send({ type: "follow.momentumEnd", offset: observe(event) }); },
      scrollEventThrottle: 16,
      maintainVisibleContentPosition: awayFromBottom ? ANCHOR : null,
      renderScrollComponent,
    },
  };
}
