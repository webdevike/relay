/**
 * A sideways pager for cards inside another sideways pager: a widget stack on a Home page. It turns
 * its pages with its own pan, and `swipeOwner` (`nestedPaging.ts`) decides each swipe after
 * `SWIPE_SLOP` points: one heading for a page it has turns it; one heading past its first or last
 * page goes to the enclosing `Pager` (rendered with `nests`, which waits for that decision); a
 * mostly vertical one goes to the scroll around it. That is how iOS hands nested horizontal
 * scrollers over: swipe a stack to its end and the next swipe turns Home.
 *
 * Controlled by `page` like `Pager`: a release settles by `settlePage` (half way, or a fling) and
 * reports through `onPageChange`; a programmatic change animates; a width change re-aligns. Pages
 * fill the pager's height. With `enabled` false (jiggle mode) it ignores swipes, so they turn Home.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { dragOffset, settlePage, swipeOwner } from "./nestedPaging";
import { OuterPagerContext } from "./Pager";

const TURN = { duration: 280, easing: Easing.out(Easing.cubic) } as const;

export interface NestedPagerProps {
  width: number;
  page: number;
  onPageChange: (page: number) => void;
  enabled?: boolean | undefined;
  style?: StyleProp<ViewStyle>;
  children: ReactNode[];
}

export function NestedPager({ width, page, onPageChange, enabled, style, children }: NestedPagerProps) {
  const outer = useContext(OuterPagerContext);
  const count = children.length;
  // The page the strip rests on or is heading to, set on the UI thread the moment a swipe lands so
  // a quick second swipe starts from it rather than from the page React has not drawn yet.
  const resting = useSharedValue(page);
  const offset = useSharedValue(-page * width);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const decided = useSharedValue(false);
  const shownWidth = useRef(width);
  // Swipes land through one stable function, so a new `onPageChange` each render keeps the gesture.
  const report = useRef(onPageChange);
  report.current = onPageChange;
  const land = useCallback((next: number) => {
    report.current(next);
  }, []);

  // A change of `page` from outside animates there; a width change re-aligns at once.
  useEffect(() => {
    const resized = shownWidth.current !== width;
    shownWidth.current = width;
    if (resized) {
      cancelAnimation(offset);
      resting.value = page;
      offset.value = -page * width;
      return;
    }
    if (resting.value === page) return;
    resting.value = page;
    offset.value = withTiming(-page * width, TURN);
  }, [page, width, offset, resting]);

  const pan = useMemo(() => {
    const gesture = Gesture.Pan()
      .enabled(enabled !== false && count > 1 && width > 0)
      .manualActivation(true)
      .maxPointers(1)
      .onTouchesDown((event) => {
        const touch = event.allTouches[0];
        if (touch === undefined) return;
        startX.value = touch.absoluteX;
        startY.value = touch.absoluteY;
        decided.value = false;
      })
      .onTouchesMove((event, manager) => {
        const touch = event.allTouches[0];
        if (decided.value || touch === undefined) return;
        const owner = swipeOwner(resting.value, count, touch.absoluteX - startX.value, touch.absoluteY - startY.value);
        if (owner === "undecided") return;
        decided.value = true;
        if (owner === "inner") manager.activate();
        else manager.fail();
      })
      .onUpdate((event) => {
        offset.value = dragOffset(resting.value, count, event.absoluteX - startX.value, width);
      })
      .onEnd((event, success) => {
        const from = resting.value;
        const next = success ? settlePage(from, count, event.absoluteX - startX.value, event.velocityX, width) : from;
        resting.value = next;
        offset.value = withTiming(-next * width, TURN);
        if (next !== from) scheduleOnRN(land, next);
      });
    return outer === null ? gesture : gesture.blocksExternalGesture(outer);
  }, [enabled, count, width, outer, land, resting, offset, startX, startY, decided]);

  const strip = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  if (width <= 0) return null;
  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.clip, style]}>
        <Animated.View style={[styles.strip, { width: width * count }, strip]}>
          {children.map((child, i) => (
            <View key={i} style={{ width }}>
              {child}
            </View>
          ))}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  strip: { flex: 1, flexDirection: "row" },
});
