import { useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const DURATION = 220;

/**
 * Opens a new row from zero height to its measured height, fading it in, so neighbours slide
 * aside instead of jumping. After the entrance the row sizes naturally (streaming text keeps growing).
 * The view tree never changes shape, so settling does not remount the row.
 */
export function GrowIn({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [settled, setSettled] = useState(!enabled);
  const height = useSharedValue(0);
  const progress = useSharedValue(enabled ? 0 : 1);
  const style = useAnimatedStyle(() => (settled ? {} : { height: height.value * progress.value, opacity: progress.value }), [settled]);
  const measure = (event: LayoutChangeEvent): void => {
    if (settled || height.value > 0) return;
    height.value = event.nativeEvent.layout.height;
    progress.value = withTiming(1, { duration: DURATION, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }, (done) => {
      if (done) scheduleOnRN(setSettled, true);
    });
  };
  return (
    <Animated.View style={[settled ? null : { overflow: "hidden" }, style]}>
      <View onLayout={measure} style={settled ? null : { position: "absolute", left: 0, right: 0, top: 0 }}>
        {children}
      </View>
    </Animated.View>
  );
}
