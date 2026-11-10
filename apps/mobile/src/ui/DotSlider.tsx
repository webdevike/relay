import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, type AccessibilityActionEvent, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useColors, useScheme } from "@/theme";
import { selectHaptic } from "@/lib/haptics";
import { stepAt, stepX } from "./sliderMath";

const TRACK_HEIGHT = 52;
const THUMB = 44;
const DOT = 6;
/** Inset of the thumb from the track's edge. */
const PAD = (TRACK_HEIGHT - THUMB) / 2;
/** Distance from the track's edge to the first step's center. */
const LEAD = PAD + THUMB / 2;
const TRACK_DARK = "#343434";
const SPRING = { damping: 22, stiffness: 420, mass: 0.7, reduceMotion: ReduceMotion.System };

export interface DotSliderProps {
  /** Step labels, low to high (for VoiceOver values). */
  steps: readonly string[];
  /** Selected step. */
  index: number;
  /** Every step change while dragging or tapping (update the label live). */
  onChange: (index: number) => void;
  /** The finger lifted (or a tap / VoiceOver adjust) on this step. */
  onCommit: (index: number) => void;
  accessibilityLabel: string;
}

/**
 * A rounded track with one dot per step and a large round thumb on the selected one (after the
 * effort dial in the Claude app). The thumb follows the finger and springs to the nearest step on
 * release; a tap jumps to its step. Needs a `GestureHandlerRootView` above it (the app root has one).
 */
export function DotSlider({ steps, index, onChange, onCommit, accessibilityLabel }: DotSliderProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const count = steps.length;
  const last = Math.max(0, count - 1);
  const [width, setWidth] = useState(0);
  const span = Math.max(0, width - 2 * LEAD);

  /** The thumb's place in steps (fractional while dragging), the step it is nearest, and the track's travel. */
  const place = useSharedValue(Math.min(Math.max(index, 0), last));
  const nearest = useSharedValue(Math.min(Math.max(index, 0), last));
  const travel = useSharedValue(0);
  const dragging = useSharedValue(false);

  // The callbacks may change every render; the gestures keep calling the latest ones.
  const handlers = useRef({ onChange, onCommit });
  handlers.current = { onChange, onCommit };
  const change = useCallback((next: number): void => {
    selectHaptic();
    handlers.current.onChange(next);
  }, []);
  const commit = useCallback((next: number): void => {
    handlers.current.onCommit(next);
  }, []);

  useEffect(() => {
    travel.value = span;
  }, [span, travel]);

  // `index` moved from outside (or after a commit): bring the thumb there unless a finger holds it.
  useEffect(() => {
    if (dragging.value) return;
    const target = Math.min(Math.max(index, 0), last);
    nearest.value = target;
    place.value = withSpring(target, SPRING);
  }, [index, last, dragging, nearest, place]);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activeOffsetX([-6, 6])
      .failOffsetY([-14, 14])
      .onStart(() => {
        dragging.value = true;
      })
      .onUpdate((event) => {
        if (travel.value <= 0 || last === 0) return;
        const next = stepAt(event.x - LEAD, travel.value, last + 1);
        place.value = Math.min(last, Math.max(0, ((event.x - LEAD) / travel.value) * last));
        if (next !== nearest.value) {
          nearest.value = next;
          scheduleOnRN(change, next);
        }
      })
      .onFinalize((_event, success) => {
        if (!dragging.value) return;
        dragging.value = false;
        place.value = withSpring(nearest.value, SPRING);
        if (success) scheduleOnRN(commit, nearest.value);
      });
    const tap = Gesture.Tap().onEnd((event, success) => {
      if (!success || travel.value <= 0) return;
      const next = stepAt(event.x - LEAD, travel.value, last + 1);
      place.value = withSpring(next, SPRING);
      if (next !== nearest.value) {
        nearest.value = next;
        scheduleOnRN(change, next);
      }
      scheduleOnRN(commit, next);
    });
    return Gesture.Race(pan, tap);
  }, [last, travel, place, nearest, dragging, change, commit]);

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: stepX(place.value, travel.value, last + 1) }] }));

  const adjust = (event: AccessibilityActionEvent): void => {
    const delta = event.nativeEvent.actionName === "increment" ? 1 : -1;
    const next = Math.min(last, Math.max(0, index + delta));
    if (next === index) return;
    handlers.current.onChange(next);
    handlers.current.onCommit(next);
  };

  const onLayout = (event: LayoutChangeEvent): void => {
    setWidth(event.nativeEvent.layout.width);
  };

  return (
    <GestureDetector gesture={gesture}>
      <View
        onLayout={onLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: steps[index] }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={adjust}
        style={[styles.track, { backgroundColor: dark ? TRACK_DARK : colors.surfaceRaised }]}
      >
        {steps.map((step, i) => (
          <View key={step} pointerEvents="none" style={[styles.dot, { backgroundColor: colors.textFaint, left: LEAD + stepX(i, span, count) - DOT / 2 }]} />
        ))}
        <Animated.View
          pointerEvents="none"
          style={[styles.thumb, dark ? styles.thumbDark : { borderColor: colors.hairline, borderWidth: StyleSheet.hairlineWidth }, thumbStyle]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  track: { height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2, justifyContent: "center" },
  dot: { position: "absolute", top: (TRACK_HEIGHT - DOT) / 2, width: DOT, height: DOT, borderRadius: DOT / 2 },
  thumb: {
    position: "absolute",
    top: PAD,
    left: PAD,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: "#FFFFFF",
    shadowColor: "#000000",
    shadowOpacity: 0.28,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  thumbDark: { borderWidth: 0 },
});
