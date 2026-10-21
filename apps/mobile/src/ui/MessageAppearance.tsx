import { useMemo, useRef, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, { FadeIn, FadeInUp, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { spacing, useColors } from "@/theme";

/** Animate only a newly received row, never history remounted by the virtualized list. */
export function MessageAppearance({ children, animate, user, gap }: { children: ReactNode; animate: boolean; user: boolean; gap: number }) {
  const colors = useColors();
  const initialEntrance = useRef(animate).current;
  const entering = useMemo(() => !initialEntrance ? undefined : user
    ? FadeIn.duration(160).reduceMotion(ReduceMotion.System)
    : FadeInUp.duration(200).withInitialValues({ opacity: 0, transform: [{ translateY: 6 }] }).reduceMotion(ReduceMotion.System), [initialEntrance, user]);
  const hover = useSharedValue(0);
  const hoverStyle = useAnimatedStyle(() => ({ opacity: hover.value }));
  const setHover = (value: number): void => { hover.value = withTiming(value, { duration: 160, reduceMotion: ReduceMotion.System }); };
  return (
    <Animated.View {...(entering ? { entering } : {})} style={{ marginTop: gap }} onPointerEnter={() => { setHover(1); }} onPointerLeave={() => { setHover(0); }}>
      {children}
      <Animated.View pointerEvents="none" style={[styles.hover, { backgroundColor: colors.hairline }, hoverStyle]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  hover: { ...StyleSheet.absoluteFillObject, marginHorizontal: spacing.lg, borderRadius: 24 },
});
