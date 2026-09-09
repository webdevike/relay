import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector, type GestureTouchEvent } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { InputEvent } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { colors, motion, radii, spacing } from "@/theme";
import { useConnectionStore } from "@/state/connection";
import { useSettingsStore } from "@/state/settings";
import { sendInput, getClientTime } from "@/connection";
import { impactHaptic, selectHaptic, tapHaptic } from "@/lib/haptics";
import { TrackpadGestureModel, type Haptic, type RawTouch, type TouchPhase } from "./gestures";

const hapticFor: Record<Haptic, () => void> = {
  select: selectHaptic,
  impactMedium: () => {
    impactHaptic("medium");
  },
  tap: tapHaptic,
};

function toRawTouches(event: GestureTouchEvent, phase: TouchPhase): RawTouch[] {
  const t = getClientTime();
  return event.changedTouches.map((touch) => ({ id: touch.id, phase, x: touch.x, y: touch.y, t }));
}

/**
 * Full-bleed trackpad. Touch handling runs entirely on the JS thread (`.runOnJS(true)`): the
 * gesture engine is a plain TS class that reads Zustand and calls `sendInput`/haptics, none of
 * which are worklet-safe, and nothing here drives a UI-thread-synced animation off the finger
 * (the only visual feedback is a discrete click flash) — so a UI-thread worklet hop would only
 * add a `scheduleOnRN` round-trip before doing the same JS work, not remove one.
 */
export function TrackpadSurface() {
  const status = useConnectionStore((state) => state.status);
  const connected = status === "connected";

  const bufferRef = useRef<InputEvent[]>([]);
  const frameScheduledRef = useRef(false);
  const frameHandleRef = useRef<number | null>(null);
  const deadRef = useRef(false);
  const flashOpacity = useSharedValue(0);

  const flushFrame = (): void => {
    frameScheduledRef.current = false;
    frameHandleRef.current = null;
    if (deadRef.current || bufferRef.current.length === 0) return;
    const batch = bufferRef.current;
    bufferRef.current = [];
    sendInput(batch);
  };

  const scheduleFlush = (): void => {
    if (deadRef.current || frameScheduledRef.current) return;
    frameScheduledRef.current = true;
    frameHandleRef.current = requestAnimationFrame(flushFrame);
  };

  const triggerFlash = (): void => {
    flashOpacity.value = 1;
    flashOpacity.value = withTiming(0, { duration: motion.duration.fast });
  };

  const model = useMemo(
    () =>
      new TrackpadGestureModel({
        getSettings: () => useSettingsStore.getState(),
        schedule: (run, ms) => {
          setTimeout(run, ms);
        },
        now: getClientTime,
        emit: (events, haptics) => {
          for (const event of events) {
            bufferRef.current.push(event);
            if (event.k === "click") triggerFlash();
          }
          scheduleFlush();
          for (const haptic of haptics) hapticFor[haptic]();
        },
      }),
    [],
  );

  useEffect(() => {
    return () => {
      // Order matters: reset() may push a closing drag-end/scroll-ended/momentumEnded into the
      // buffer (see gestures.ts) — cancel the pending frame, flush that synchronously so it
      // still reaches sendInput, then go dead so nothing further can send on this surface.
      model.reset();
      if (frameHandleRef.current !== null) {
        cancelAnimationFrame(frameHandleRef.current);
        frameScheduledRef.current = false;
        frameHandleRef.current = null;
      }
      flushFrame();
      deadRef.current = true;
    };
  }, [model]);

  const gesture = useMemo(
    () =>
      Gesture.Manual()
        .runOnJS(true)
        .onTouchesDown((event) => {
          for (const touch of toRawTouches(event, "began")) model.touch(touch);
        })
        .onTouchesMove((event) => {
          for (const touch of toRawTouches(event, "moved")) model.touch(touch);
        })
        .onTouchesUp((event) => {
          for (const touch of toRawTouches(event, "ended")) model.touch(touch);
        })
        .onTouchesCancelled((event) => {
          for (const touch of toRawTouches(event, "cancelled")) model.touch(touch);
        }),
    [model],
  );

  const flashStyle = useAnimatedStyle(() => ({ opacity: flashOpacity.value }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.touchArea}>
        <View style={styles.surface}>
          <Animated.View pointerEvents="none" style={[styles.flash, flashStyle]} />
          {!connected && (
            <View style={styles.overlay} pointerEvents="none">
              <Text variant="body" color="textFaint">
                Not connected
              </Text>
              <Text variant="caption" color="textFaint">
                {status}
              </Text>
            </View>
          )}
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  touchArea: { flex: 1 },
  surface: {
    flex: 1,
    margin: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  flash: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.surfaceRaised },
  overlay: { alignItems: "center", gap: spacing.xs },
});
