/**
 * A reply's follow-up widget (protocol "Reply widgets"): the ```openui block the widget agent picked
 * for an assistant's finished reply, drawn under the reply by the same `MessageText` / `OpenUIBlock`
 * path as a widget the reply wrote itself, in a bubble-filled card.
 *
 * A block that arrived live (`useReplyWidgetsStore().fresh`) first asks the list to keep its place
 * (`KeepPlaceContext`, `useInvertedChatScroll` `keepPlace`: following the newest row would push the
 * reply up by the widget's height), mounts two frames later once the list anchors the reply, and
 * slides in (a fade with Reduce Motion). One from the thread's snapshot just renders. Either way the
 * mark is cleared, so a row the list recycles never animates again.
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { FadeIn, FadeInDown, useReducedMotion } from "react-native-reanimated";
import { MessageText } from "@/agents/MessageText";
import { useReplyWidgetsStore } from "@/state/replyWidgets";

/** The chat list's `keepPlace`; null outside a list that follows its newest row. */
export const KeepPlaceContext = createContext<(() => void) | null>(null);

/**
 * Whether content that arrived `live` may show yet: while `live` turns true, it first asks the list
 * to keep its place (`KeepPlaceContext`) and holds the content back two frames, until the list
 * anchors what Isaac reads; content that is not live shows at once. A reply's follow-up widget and
 * a trial card (its arrival and each result filling in) use it.
 */
export function useKeptArrival(live: boolean): boolean {
  const keepPlace = useContext(KeepPlaceContext);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (!live) return undefined;
    keepPlace?.();
    // The list re-renders with anchoring on in the next commit; mount after it so the reply stays put.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        setArrived(true);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [live, keepPlace]);
  return !live || arrived;
}

const SLIDE_MS = 240;
const FADE_MS = 160;

export interface ReplyFollowUpProps {
  thread: string;
  /** The reply's reaction key. */
  messageKey: string;
  /** The whole ```openui fence. */
  block: string;
  /** The card's look (fill, radius, padding, spacing from the reply). */
  style: StyleProp<ViewStyle>;
}

export function ReplyFollowUp({ thread, messageKey, block, style }: ReplyFollowUpProps) {
  const fresh = useReplyWidgetsStore((state) => state.fresh[thread]?.includes(messageKey) === true);
  // Only a block that was new when this row drew it animates; a later change to it just redraws.
  const [live] = useState(fresh);
  const shown = useKeptArrival(live);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (fresh) useReplyWidgetsStore.getState().settle(thread, messageKey);
  }, [fresh, thread, messageKey]);

  if (!shown) return null;
  const body = <MessageText text={block} large />;
  if (!live)
    return (
      <Animated.View style={style} testID="eva-followup-widget">
        {body}
      </Animated.View>
    );
  return (
    <Animated.View
      entering={reducedMotion ? FadeIn.duration(FADE_MS) : FadeInDown.duration(SLIDE_MS)}
      style={style}
      testID="eva-followup-widget"
    >
      {body}
    </Animated.View>
  );
}
