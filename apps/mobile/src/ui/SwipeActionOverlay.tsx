/**
 * What a swipe will do, drawn over a `SwipeCard` while it is dragged toward `side`: the card tints
 * in `color`, and a ring in the corner the card is leaving from fills as the drag nears the
 * threshold, around a glyph, with the action's label beside it. Invisible while dragged the other way.
 */
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useDerivedValue, type SharedValue } from "react-native-reanimated";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "./Text";
import { RadialProgress } from "./RadialProgress";
import type { SwipeDirection } from "./SwipeCard";
import { spacing, withAlpha } from "@/theme";

export interface SwipeActionOverlayProps {
  side: SwipeDirection;
  /** The card's signed drag progress: -1 at the left threshold, 1 at the right. */
  progress: SharedValue<number>;
  color: string;
  symbol: SFSymbol;
  label: string;
  radius: number;
}

const RING = 44;
const INK = "#FFFFFF";

export function SwipeActionOverlay({ side, progress, color, symbol, label, radius }: SwipeActionOverlayProps) {
  const amount = useDerivedValue(() => Math.max(0, side === "right" ? progress.value : -progress.value));
  // The tint comes in quickly so the action reads early; the ring keeps counting to the threshold.
  const tint = useAnimatedStyle(() => ({ opacity: Math.min(1, amount.value * 1.6) * 0.94 }));
  const badge = useAnimatedStyle(() => ({ opacity: Math.min(1, amount.value * 3) }));
  // A right throw leaves from the left edge: its badge sits top-left, a left throw's top-right.
  const corner = side === "right" ? styles.left : styles.right;
  return (
    <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden" }]} pointerEvents="none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color }, tint]} />
      <Animated.View style={[styles.badge, corner, badge]}>
        <RadialProgress progress={amount} size={RING} stroke={3} color={INK} trackColor={withAlpha(INK, 0.3)}>
          <SymbolView name={symbol} size={20} tintColor={INK} weight="semibold" />
        </RadialProgress>
        <Text variant="label" style={styles.label}>
          {label}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: "absolute", top: spacing.xl, alignItems: "center", gap: spacing.sm },
  left: { left: spacing.xl },
  right: { right: spacing.xl },
  label: { color: INK, fontWeight: "600" },
});
