/**
 * What a swipe will do, drawn over a `SwipeCard` while it is dragged toward `side`: the card tints
 * in `color`, and a ring in the corner the card is leaving from fills as the drag nears the
 * threshold, around a glyph, with the action's label beside it. Invisible while dragged the other way.
 */
import { Animated, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "./Text";
import { RadialProgress } from "./RadialProgress";
import type { SwipeDirection, SwipeProgress } from "./SwipeCard";
import { spacing, withAlpha } from "@/theme";

export interface SwipeActionOverlayProps {
  side: SwipeDirection;
  /** The card's signed drag progress: -1 at the left threshold, 1 at the right. */
  progress: SwipeProgress;
  color: string;
  symbol: SFSymbol;
  label: string;
  radius: number;
}

const RING = 44;
const INK = "#FFFFFF";

export function SwipeActionOverlay({ side, progress, color, symbol, label, radius }: SwipeActionOverlayProps) {
  const amount = progress.interpolate({ inputRange: side === "right" ? [0, 1] : [-1, 0], outputRange: side === "right" ? [0, 1] : [1, 0], extrapolate: "clamp" });
  // The tint comes in quickly and hides the card's text well before the threshold; the ring keeps counting to it.
  const tint = { opacity: amount.interpolate({ inputRange: [0, 1 / 1.5], outputRange: [0, 1], extrapolate: "clamp" }) };
  const badge = { opacity: amount.interpolate({ inputRange: [0, 1 / 3], outputRange: [0, 1], extrapolate: "clamp" }) };
  // A right throw leaves from the left edge: its badge sits top-left with the label after the ring, a left throw's top-right.
  const corner = side === "right" ? styles.left : styles.right;
  return (
    // No clipping container: the tint carries the card's corners itself, so nothing here needs an offscreen mask pass.
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color, borderRadius: radius, borderCurve: "continuous" }, tint]} />
      <Animated.View style={[styles.badge, corner, badge]}>
        <RadialProgress progress={amount} size={RING} stroke={3} color={INK} trackColor={withAlpha(INK, 0.3)}>
          <SymbolView name={symbol} size={20} tintColor={INK} weight="semibold" />
        </RadialProgress>
        <Text variant="title" style={styles.label}>
          {label}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: "absolute", top: spacing.xl, flexDirection: "row", alignItems: "center", gap: spacing.md },
  left: { left: spacing.xl },
  right: { right: spacing.xl, flexDirection: "row-reverse" },
  label: { color: INK },
});
