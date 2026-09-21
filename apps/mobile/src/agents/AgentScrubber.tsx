import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { AgentStatus } from "@relay/protocol";
import { colors, motion } from "@/theme";
import { impactHaptic, selectHaptic } from "@/lib/haptics";
import { loadSkia } from "@/dictation/skia";

export const TRACK_HEIGHT = 44;
const TRACK_PADDING = 4;
const THUMB_HEIGHT = TRACK_HEIGHT - TRACK_PADDING * 2;
const TICK = 6;
const SNAP = { damping: 22, stiffness: 320, mass: 0.6 };

const tickColor: Record<AgentStatus, string> = {
  working: colors.working,
  waiting: colors.warn,
  needs_permission: colors.warn,
  idle: colors.textFaint,
  ended: colors.textFaint,
};

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
 */
export function AgentScrubber({
  statuses,
  index,
  divider,
  onChange,
  onLongPress,
}: AgentScrubberProps) {
  const count = statuses.length;
  const [trackWidth, setTrackWidth] = useState(0);
  const slot = count === 0 ? 0 : trackWidth / count;

  const slotWidth = useSharedValue(0);
  const slots = useSharedValue(count);
  const current = useSharedValue(index);
  const thumbX = useSharedValue(0);
  const dragging = useSharedValue(false);

  useEffect(() => {
    slotWidth.value = slot;
    slots.value = count;
  }, [slot, count, slotWidth, slots]);

  // Settle the thumb whenever the selection changes for any reason other than the finger.
  useEffect(() => {
    current.value = index;
    if (!dragging.value) thumbX.value = withSpring(index * slot, SNAP);
  }, [index, slot, current, dragging, thumbX]);

  const gesture = useMemo(() => {
    const select = (x: number): void => {
      "worklet";
      if (slotWidth.value === 0 || slots.value === 0) return;
      const next = Math.min(slots.value - 1, Math.max(0, Math.floor(x / slotWidth.value)));
      if (next === current.value) return;
      current.value = next;
      scheduleOnRN(selectHaptic);
      scheduleOnRN(onChange, next);
    };
    const follow = (x: number): void => {
      "worklet";
      const max = slotWidth.value * (slots.value - 1);
      thumbX.value = Math.min(max, Math.max(0, x - slotWidth.value / 2));
    };
    const settle = (): void => {
      "worklet";
      dragging.value = false;
      thumbX.value = withSpring(current.value * slotWidth.value, SNAP);
    };
    const pan = Gesture.Pan()
      .activateAfterLongPress(0)
      .minDistance(0)
      .onBegin((event) => {
        dragging.value = true;
        select(event.x);
        follow(event.x);
      })
      .onUpdate((event) => {
        select(event.x);
        follow(event.x);
      })
      .onFinalize(settle);
    const hold = Gesture.LongPress()
      .minDuration(LONG_PRESS_MS)
      .onStart(() => {
        scheduleOnRN(impactHaptic, "medium");
        scheduleOnRN(onLongPress, current.value);
      });
    return Gesture.Simultaneous(pan, hold);
  }, [slotWidth, slots, current, thumbX, dragging, onChange, onLongPress]);

  const thumbStyle = useAnimatedStyle(() => ({
    width: Math.max(0, slotWidth.value - TRACK_PADDING * 2),
    transform: [{ translateX: thumbX.value + TRACK_PADDING }],
    backgroundColor: withTiming(
      dragging.value ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.12)",
      { duration: motion.duration.fast },
    ),
  }));
  // Skia draws the pills from exact geometry; the View fallback is for a client built without it.
  const thumbXPx = useDerivedValue(() => thumbX.value + TRACK_PADDING);
  const thumbWidth = useDerivedValue(() => Math.max(0, slotWidth.value - TRACK_PADDING * 2));
  const thumbColor = useDerivedValue(() =>
    withTiming(dragging.value ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.12)", {
      duration: motion.duration.fast,
    }),
  );

  const onLayout = (event: LayoutChangeEvent): void => {
    setTrackWidth(event.nativeEvent.layout.width);
  };

  const sk = loadSkia();
  const dividerAt = divider !== undefined && divider > 0 && divider < count ? divider * slot : null;
  const body =
    sk === null ? (
      <View style={styles.track} onLayout={onLayout} accessibilityRole="adjustable">
        {statuses.map((status, i) => (
          <View
            key={i}
            style={[
              styles.tick,
              { left: i * slot + slot / 2 - TICK / 2, backgroundColor: tickColor[status] },
            ]}
          />
        ))}
        {dividerAt !== null && (
          <View style={[styles.divider, { left: dividerAt - StyleSheet.hairlineWidth / 2 }]} />
        )}
        {count > 0 && <Animated.View style={[styles.thumb, thumbStyle]} />}
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
              cx={i * slot + slot / 2}
              cy={TRACK_HEIGHT / 2}
              r={TICK / 2}
              color={tickColor[status]}
            />
          ))}
          {count > 0 && (
            <sk.RoundedRect
              x={thumbXPx}
              y={TRACK_PADDING}
              width={thumbWidth}
              height={THUMB_HEIGHT}
              r={THUMB_HEIGHT / 2}
              color={thumbColor}
            />
          )}
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
    backgroundColor: colors.bg,
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
    backgroundColor: colors.hairline,
  },
  thumb: {
    position: "absolute",
    top: TRACK_PADDING,
    height: THUMB_HEIGHT,
    borderRadius: THUMB_HEIGHT / 2,
    // No border: with one, RN draws the pill through its own path code and the ends come out
    // visibly un-round; a plain fill goes through CALayer cornerRadius, which is exact.
    backgroundColor: "rgba(255,255,255,0.12)",
  },
});
