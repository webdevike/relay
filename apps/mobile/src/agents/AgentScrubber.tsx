import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import type { AgentStatus } from "@relay/protocol";
import { colors, motion } from "@/theme";
import { selectHaptic } from "@/lib/haptics";

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
  onChange: (index: number) => void;
}

/**
 * One slot per session. The thumb rides the finger while dragging and snaps into the nearest slot
 * on release; crossing a slot boundary selects that session immediately (with a tick), so the card
 * above changes while the thumb is still moving.
 */
export function AgentScrubber({ statuses, index, onChange }: AgentScrubberProps) {
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
    return Gesture.Pan()
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
  }, [slotWidth, slots, current, thumbX, dragging, onChange]);

  const thumbStyle = useAnimatedStyle(() => ({
    width: Math.max(0, slotWidth.value - TRACK_PADDING * 2),
    transform: [{ translateX: thumbX.value + TRACK_PADDING }, { scale: withTiming(dragging.value ? 1.04 : 1, { duration: motion.duration.fast }) }],
  }));

  const onLayout = (event: LayoutChangeEvent): void => {
    setTrackWidth(event.nativeEvent.layout.width);
  };

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.track} onLayout={onLayout} accessibilityRole="adjustable">
        {statuses.map((status, i) => (
          <View
            key={i}
            style={[styles.tick, { left: i * slot + slot / 2 - TICK / 2, backgroundColor: tickColor[status] }]}
          />
        ))}
        {count > 0 && <Animated.View style={[styles.thumb, thumbStyle]} />}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: colors.bg,
    justifyContent: "center",
  },
  tick: {
    position: "absolute",
    width: TICK,
    height: TICK,
    borderRadius: TICK / 2,
  },
  thumb: {
    position: "absolute",
    top: TRACK_PADDING,
    height: THUMB_HEIGHT,
    borderRadius: THUMB_HEIGHT / 2,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
});
