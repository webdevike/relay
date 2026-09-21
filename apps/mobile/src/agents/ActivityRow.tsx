/**
 * The bottom-of-transcript sign of life while a session is working and nothing is streaming:
 * a breathing dot and what the agent is on ("Running bash", "Thinking"). Without it the phone
 * shows nothing between the user's message and the first tool row.
 */
import { useEffect } from "react";
import { View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { colors, spacing } from "@/theme";
import { Text } from "@/ui/Text";

const BREATH_MS = 900;
const DOT = 8;

export interface ActivityRowProps {
  /** What the agent is on: "Thinking", "Running bash", "Starting omp". */
  label: string;
}

export function ActivityRow({ label }: ActivityRowProps) {
  const breath = useSharedValue(0.35);
  useEffect(() => {
    breath.value = withRepeat(withTiming(1, { duration: BREATH_MS, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [breath]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: breath.value }));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.xs }}>
      <Animated.View style={[{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.working }, dotStyle]} />
      <Text variant="caption" color="textMuted" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
