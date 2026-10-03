import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { motion, useColors, type ColorToken } from "@/theme";
import type { AgentStatus } from "@relay/protocol";

const statusColor: Record<AgentStatus, ColorToken> = {
  working: "working",
  waiting: "warn",
  needs_permission: "warn",
  idle: "textFaint",
  ended: "textFaint",
};

export interface StatusDotProps {
  status: AgentStatus;
  size?: number;
}

export function StatusDot({ status, size = 8 }: StatusDotProps) {
  const colors = useColors();
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (status !== "working") {
      cancelAnimation(pulse);
      pulse.value = withTiming(1, { duration: motion.duration.fast });
      return;
    }
    pulse.value = withRepeat(
      withTiming(0.35, { duration: 700, easing: Easing.out(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(pulse);
    };
  }, [status, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Animated.View
        style={[
          styles.dot,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: colors[statusColor[status]] },
          animatedStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  dot: {},
});
