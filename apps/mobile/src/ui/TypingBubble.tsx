import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { spacing, useColors } from "@/theme";
import { Text } from "./Text";

/** Quiet activity, not a simulated reasoning transcript. Elapsed time is local to this turn. */
export function TypingBubble({ streaming = false, label: suppliedLabel }: { streaming?: boolean; label?: string }) {
  const colors = useColors();
  const reducedMotion = useReducedMotion();
  const started = useRef(Date.now());
  const [seconds, setSeconds] = useState(0);
  const opacity = useSharedValue(0.65);
  useEffect(() => {
    const timer = setInterval(() => { setSeconds(Math.floor((Date.now() - started.current) / 1000)); }, 1000);
    return () => { clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!reducedMotion) opacity.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => { cancelAnimation(opacity); };
  }, [opacity, reducedMotion]);
  const pulse = useAnimatedStyle(() => ({ opacity: reducedMotion ? 1 : opacity.value }));
  const label = suppliedLabel ?? (streaming ? "Responding" : "Working");
  return (
    <View accessible accessibilityLabel={label} style={styles.root}>
      <Animated.View style={pulse}><SymbolView name="sparkle" size={16} tintColor={colors.textMuted} /></Animated.View>
      <Text color="textMuted" numberOfLines={1} style={styles.label}>{label}</Text>
      <Text color="textFaint" style={styles.elapsed}>{seconds}s</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  label: { fontSize: 15, lineHeight: 22, flexShrink: 1 },
  elapsed: { fontSize: 13, lineHeight: 22, fontVariant: ["tabular-nums"] },
});
