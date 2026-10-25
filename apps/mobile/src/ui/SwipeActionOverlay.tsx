/**
 * What a swipe will do, drawn over a `SwipeCard` while it is dragged toward `side`: the card tints
 * in `color`, and a ring fills as the drag nears the threshold, around a glyph (or an initial, for
 * who it goes to), with the action's label beside it. Sideways the ring sits in the corner the card
 * is leaving from; up it sits centred at the top with the label under it. Invisible otherwise.
 */
import { Animated, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "./Text";
import { RadialProgress } from "./RadialProgress";
import type { SwipeDirection, SwipeSignals } from "./SwipeCard";
import { spacing, withAlpha } from "@/theme";

export interface SwipeActionOverlayProps {
  side: SwipeDirection;
  signals: SwipeSignals;
  color: string;
  /** Inside the ring: a glyph, or `initial` (a letter, e.g. the assistant it goes to). */
  symbol?: SFSymbol | undefined;
  initial?: string | undefined;
  label: string;
  radius: number;
}

const RING = 44;
const INK = "#FFFFFF";

export function SwipeActionOverlay({ side, signals, color, symbol, initial, label, radius }: SwipeActionOverlayProps) {
  const amount =
    side === "up"
      ? signals.up
      : signals.horizontal.interpolate({
          inputRange: side === "right" ? [0, 1] : [-1, 0],
          outputRange: side === "right" ? [0, 1] : [1, 0],
          extrapolate: "clamp",
        });
  // The tint comes in quickly and hides the card's text well before the threshold; the ring keeps counting to it.
  const tint = { opacity: amount.interpolate({ inputRange: [0, 1 / 1.5], outputRange: [0, 1], extrapolate: "clamp" }) };
  const badge = { opacity: amount.interpolate({ inputRange: [0, 1 / 3], outputRange: [0, 1], extrapolate: "clamp" }) };
  // A right throw leaves from the left edge: its badge sits top-left with the label after the ring, a left throw's top-right.
  const place = side === "up" ? styles.top : side === "right" ? styles.left : styles.right;
  return (
    // No clipping container: the tint carries the card's corners itself, so nothing here needs an offscreen mask pass.
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color, borderRadius: radius, borderCurve: "continuous" }, tint]} />
      <Animated.View style={[styles.badge, place, badge]}>
        <RadialProgress progress={amount} size={RING} stroke={3} color={INK} trackColor={withAlpha(INK, 0.3)}>
          {initial !== undefined ? (
            <Text variant="title" style={styles.ink}>
              {initial}
            </Text>
          ) : symbol !== undefined ? (
            <SymbolView name={symbol} size={20} tintColor={INK} weight="semibold" />
          ) : null}
        </RadialProgress>
        <Text variant="title" style={styles.ink}>
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
  top: { left: 0, right: 0, flexDirection: "column", gap: spacing.sm },
  ink: { color: INK },
});
