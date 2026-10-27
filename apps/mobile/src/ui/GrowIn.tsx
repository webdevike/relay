import { useEffect, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const TIMING = { duration: 220, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System };
/**
 * At rest the row's height belongs to layout. It has to be said outright: a key dropped from an
 * animated style keeps its last value, which pinned rows at their first measured height and let
 * streamed lines spill over the rows below.
 */
const AT_REST = { height: "auto", opacity: 1 } as const;
const CLIP = { overflow: "hidden" } as const;
const OFF_FLOW = { position: "absolute", left: 0, right: 0, top: 0 } as const;

export interface GrowInProps {
  children: ReactNode;
  /** Open from zero height on mount (a row that just arrived); false mounts the row at rest. */
  enabled: boolean;
  /** Turning false collapses the row back to zero height, fading it out, then calls `onClosed`. */
  open?: boolean;
  onClosed?: () => void;
}

/**
 * Opens a row from zero height to its content's height, fading it in, so neighbours slide aside
 * instead of jumping; closing runs the same in reverse. While it opens, the content is measured off
 * flow and the height follows every measurement, so words streaming in mid-entrance are never cut
 * off, and an empty row waits at zero height until it has something to show. A closing row keeps
 * its content in flow: switching it off flow at the start would collapse the row for a frame before
 * the animated height takes over. The view tree never changes shape, so settling does not remount.
 */
export function GrowIn({ children, enabled, open = true, onClosed }: GrowInProps) {
  const [settled, setSettled] = useState(!enabled);
  const height = useSharedValue(0);
  const progress = useSharedValue(enabled ? 0 : 1);
  const style = useAnimatedStyle(() => (settled ? AT_REST : { height: height.value * progress.value, opacity: progress.value }), [settled]);
  const settle = (): void => {
    setSettled(true);
  };
  const closed = (): void => {
    onClosed?.();
  };
  useEffect(() => {
    if (open) {
      // Reopened while collapsing: run back up from where it is.
      if (height.value > 0 && progress.value < 1) {
        progress.value = withTiming(1, TIMING, (done) => {
          if (done) scheduleOnRN(settle);
        });
      }
      return;
    }
    setSettled(false);
    progress.value = withTiming(0, TIMING, (done) => {
      if (done) scheduleOnRN(closed);
    });
    // Only a change of `open` moves the row; the callbacks read the latest render's props.
  }, [open]);
  const measure = (event: LayoutChangeEvent): void => {
    // A closing row is squeezed by its own height: what it measures then is not its content.
    if (!open) return;
    const measured = event.nativeEvent.layout.height;
    const first = height.value === 0;
    height.value = measured;
    if (!settled && first && measured > 0) {
      progress.value = withTiming(1, TIMING, (done) => {
        if (done) scheduleOnRN(settle);
      });
    }
  };
  return (
    <Animated.View style={[settled ? null : CLIP, style]}>
      <View onLayout={measure} style={settled || !open ? null : OFF_FLOW}>
        {children}
      </View>
    </Animated.View>
  );
}
