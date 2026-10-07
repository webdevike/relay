import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withSpring,
  withTiming,
  type FrameInfo,
} from "react-native-reanimated";
import type { AgentStatus } from "@relay/protocol";
import { motion, useColors, useScheme, type Colors } from "@/theme";
import { impactHaptic, selectHaptic } from "@/lib/haptics";
import { loadSkia } from "@/dictation/skia";
import {
  ARM_DISTANCE,
  TRACK_PADDING,
  edgeScroll,
  endInset,
  maxOffset,
  revealOffset,
  slotAt,
  slotCenter,
  slotWidthFor,
  thumbSpan,
} from "./scrubberGeometry";

export const TRACK_HEIGHT = 44;
const THUMB_HEIGHT = TRACK_HEIGHT - TRACK_PADDING * 2;
const TICK = 6;
const SNAP = { damping: 22, stiffness: 320, mass: 0.6 };

function tickColor(colors: Colors, status: AgentStatus): string {
  switch (status) {
    case "working":
      return colors.working;
    case "waiting":
    case "needs_permission":
      return colors.warn;
    case "idle":
    case "ended":
      return colors.textFaint;
  }
}

/** Thumb fill at rest and while dragging: a light wash on dark, a dark wash on light. */
const THUMB_FILL = {
  dark: { rest: "rgba(255,255,255,0.12)", drag: "rgba(255,255,255,0.18)" },
  light: { rest: "rgba(0,0,0,0.07)", drag: "rgba(0,0,0,0.11)" },
} as const;

export interface AgentScrubberProps {
  statuses: AgentStatus[];
  index: number;
  /** Slot the second section (job runs) starts at; a hairline splits the track before it. */
  divider?: number;
  onChange: (index: number) => void;
  /** Finger held still on a slot: open that session's settings. Fires after the slot is selected. */
  onLongPress: (index: number) => void;
}

const LONG_PRESS_MS = 450;

/**
 * One slot per session. The thumb rides the finger while dragging and snaps into the nearest slot
 * on release; crossing a slot boundary selects that session immediately (with a tick), so the card
 * above changes while the thumb is still moving. Holding still on a slot opens its settings.
 *
 * Slots never shrink below `MIN_SLOT`: past that the dots scroll inside the track. Dragging into
 * either end scrolls them (faster the deeper the finger goes) and keeps selecting as slots pass
 * under it; outside a drag the track scrolls just enough to keep the selected slot in view.
 */
export function AgentScrubber({
  statuses,
  index,
  divider,
  onChange,
  onLongPress,
}: AgentScrubberProps) {
  const colors = useColors();
  const { rest, drag } = THUMB_FILL[useScheme()];
  const count = statuses.length;
  const [trackWidth, setTrackWidth] = useState(0);
  const slot = slotWidthFor(trackWidth, count);

  const track = useSharedValue(0);
  const slotWidth = useSharedValue(0);
  const slots = useSharedValue(count);
  const current = useSharedValue(index);
  /** Thumb position as a slot index; fractional while it rides the finger or springs. */
  const thumbPos = useSharedValue(0);
  const dragging = useSharedValue(false);
  /** How far the dots are scrolled left, in points. */
  const offset = useSharedValue(0);
  /** Finger position in track coordinates; content position is this plus `offset`. */
  const fingerX = useSharedValue(0);
  const startX = useSharedValue(0);
  /** Edge scrolling waits for real movement, so tapping an end slot doesn't drift the track. */
  const armed = useSharedValue(false);

  useEffect(() => {
    track.value = trackWidth;
    slotWidth.value = slot;
    slots.value = count;
  }, [trackWidth, slot, count, track, slotWidth, slots]);

  // Settle the thumb, and scroll the selection into view, whenever the selection or geometry
  // changes for any reason other than the finger.
  useEffect(() => {
    current.value = index;
    if (dragging.value) return;
    thumbPos.value = withSpring(index, SNAP);
    offset.value = withSpring(revealOffset(offset.value, index, slot, count, trackWidth), SNAP);
  }, [index, slot, count, trackWidth, current, dragging, thumbPos, offset]);

  const scrubber = useMemo(() => {
    const select = (x: number): void => {
      "worklet";
      if (slotWidth.value === 0 || slots.value === 0) return;
      const next = slotAt(x, slotWidth.value, slots.value);
      if (next === current.value) return;
      current.value = next;
      scheduleOnRN(selectHaptic);
      scheduleOnRN(onChange, next);
    };
    const follow = (x: number): void => {
      "worklet";
      if (slotWidth.value === 0) return;
      const pos = (x - endInset(slotWidth.value)) / slotWidth.value - 0.5;
      thumbPos.value = Math.min(slots.value - 1, Math.max(0, pos));
    };
    const scrub = (): void => {
      "worklet";
      const x = fingerX.value + offset.value;
      select(x);
      follow(x);
    };
    return { scrub };
  }, [slotWidth, slots, current, thumbPos, fingerX, offset, onChange]);

  // Runs only while a finger is down (toggled from the gesture); scrolls when it sits in an end zone.
  const step = useCallback(
    (frame: FrameInfo) => {
      "worklet";
      if (!dragging.value || !armed.value) return;
      const max = maxOffset(track.value, slotWidth.value, slots.value);
      const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
      const next = edgeScroll(offset.value, fingerX.value, track.value, max, dt);
      if (next === offset.value) return;
      offset.value = next;
      scrubber.scrub();
    },
    [dragging, armed, track, slotWidth, slots, offset, fingerX, scrubber],
  );
  const edge = useFrameCallback(step, false);
  const setEdge = useCallback(
    (on: boolean) => {
      edge.setActive(on);
    },
    [edge],
  );

  const gesture = useMemo(() => {
    const settle = (): void => {
      "worklet";
      dragging.value = false;
      thumbPos.value = withSpring(current.value, SNAP);
      offset.value = withSpring(
        revealOffset(offset.value, current.value, slotWidth.value, slots.value, track.value),
        SNAP,
      );
      scheduleOnRN(setEdge, false);
    };
    const pan = Gesture.Pan()
      .activateAfterLongPress(0)
      .minDistance(0)
      .onBegin((event) => {
        dragging.value = true;
        armed.value = false;
        startX.value = event.x;
        fingerX.value = event.x;
        // Stop any reveal spring so the content holds still under the finger.
        cancelAnimation(offset);
        scrubber.scrub();
        scheduleOnRN(setEdge, true);
      })
      .onUpdate((event) => {
        fingerX.value = event.x;
        if (Math.abs(event.x - startX.value) > ARM_DISTANCE) armed.value = true;
        scrubber.scrub();
      })
      .onFinalize(settle);
    const hold = Gesture.LongPress()
      .minDuration(LONG_PRESS_MS)
      .onStart(() => {
        scheduleOnRN(impactHaptic, "medium");
        scheduleOnRN(onLongPress, current.value);
      });
    return Gesture.Simultaneous(pan, hold);
  }, [slotWidth, slots, track, current, thumbPos, dragging, armed, startX, fingerX, offset, scrubber, setEdge, onLongPress]);

  const thumbStyle = useAnimatedStyle(() => {
    const { x, width } = thumbSpan(thumbPos.value, slotWidth.value);
    return {
      width,
      transform: [{ translateX: x }],
      backgroundColor: withTiming(dragging.value ? drag : rest, { duration: motion.duration.fast }),
    };
  });
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -offset.value }] }));
  // Skia draws the pills from exact geometry; the View fallback is for a client built without it.
  // One rrect rebuilt per frame: feeding animated x/width as separate props left Skia with radii
  // clamped from the first (zero-width) layout, which flattened the thumb's left end.
  const sk = loadSkia();
  const thumbRRect = useDerivedValue(() => {
    const { x, width } = thumbSpan(thumbPos.value, slotWidth.value);
    const rect = { x, y: TRACK_PADDING, width, height: THUMB_HEIGHT };
    return { rect, rx: THUMB_HEIGHT / 2, ry: THUMB_HEIGHT / 2 };
  });
  const thumbColor = useDerivedValue(() =>
    withTiming(dragging.value ? drag : rest, {
      duration: motion.duration.fast,
    }),
  );
  const contentTransform = useDerivedValue(() => [{ translateX: -offset.value }]);

  const onLayout = (event: LayoutChangeEvent): void => {
    setTrackWidth(event.nativeEvent.layout.width);
  };

  const dividerAt =
    divider !== undefined && divider > 0 && divider < count ? slotCenter(divider, slot) - slot / 2 : null;
  const body =
    sk === null ? (
      <View style={[styles.track, { backgroundColor: colors.bg }]} onLayout={onLayout} accessibilityRole="adjustable">
        <Animated.View style={[StyleSheet.absoluteFill, contentStyle]}>
          {statuses.map((status, i) => (
            <View
              key={i}
              style={[
                styles.tick,
                { left: slotCenter(i, slot) - TICK / 2, backgroundColor: tickColor(colors, status) },
              ]}
            />
          ))}
          {dividerAt !== null && (
            <View style={[styles.divider, { left: dividerAt - StyleSheet.hairlineWidth / 2, backgroundColor: colors.hairline }]} />
          )}
          {count > 0 && <Animated.View style={[styles.thumb, { backgroundColor: rest }, thumbStyle]} />}
        </Animated.View>
      </View>
    ) : (
      <View style={styles.trackBox} onLayout={onLayout} accessibilityRole="adjustable">
        <sk.Canvas style={StyleSheet.absoluteFill}>
          <sk.RoundedRect
            x={0}
            y={0}
            width={trackWidth}
            height={TRACK_HEIGHT}
            r={TRACK_HEIGHT / 2}
            color={colors.bg}
          />
          {/* Clip in track space, scroll inside it, so dots and thumb vanish under the rounded ends. */}
          <sk.Group clip={sk.rrect(sk.rect(0, 0, trackWidth, TRACK_HEIGHT), TRACK_HEIGHT / 2, TRACK_HEIGHT / 2)}>
            <sk.Group transform={contentTransform}>
              {dividerAt !== null && (
                <sk.Rect
                  x={dividerAt - 0.25}
                  y={TRACK_PADDING * 2}
                  width={0.5}
                  height={TRACK_HEIGHT - TRACK_PADDING * 4}
                  color={colors.hairline}
                />
              )}
              {statuses.map((status, i) => (
                <sk.Circle
                  key={i}
                  cx={slotCenter(i, slot)}
                  cy={TRACK_HEIGHT / 2}
                  r={TICK / 2}
                  color={tickColor(colors, status)}
                />
              ))}
              {count > 0 && <sk.RoundedRect rect={thumbRRect} color={thumbColor} />}
            </sk.Group>
          </sk.Group>
        </sk.Canvas>
      </View>
    );

  return <GestureDetector gesture={gesture}>{body}</GestureDetector>;
}

const styles = StyleSheet.create({
  trackBox: { height: TRACK_HEIGHT },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    justifyContent: "center",
    overflow: "hidden",
  },
  tick: {
    position: "absolute",
    width: TICK,
    height: TICK,
    borderRadius: TICK / 2,
  },
  divider: {
    position: "absolute",
    top: TRACK_PADDING * 2,
    bottom: TRACK_PADDING * 2,
    width: StyleSheet.hairlineWidth,
  },
  thumb: {
    position: "absolute",
    top: TRACK_PADDING,
    height: THUMB_HEIGHT,
    borderRadius: THUMB_HEIGHT / 2,
    // No border: with one, RN draws the pill through its own path code and the ends come out
    // visibly un-round; a plain fill goes through CALayer cornerRadius, which is exact.
    // The fill itself comes from the animated style.
  },
});
