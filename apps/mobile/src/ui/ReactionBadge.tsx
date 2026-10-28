/**
 * A chat bubble's reaction, iMessage style: a small round badge straddling the bubble's outer top
 * corner (top-right of the agent's bubbles, top-left of Isaac's), ringed in the page colour so it
 * reads as sitting on the bubble's edge. It pops in when the reaction lands (a fade with Reduce
 * Motion) and, tapped, opens the bubble's reaction overlay.
 */
import { Pressable, StyleSheet } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn } from "react-native-reanimated";
import { Text } from "@/ui/Text";
import { mixHex, useColors, useScheme } from "@/theme";

export const REACTION_BADGE_SIZE = 30;
/** How far the badge sticks out past the bubble's top edge; a reacted bubble keeps this much room above it. */
export const REACTION_BADGE_OVERHANG = 18;
/** How far it sticks out past the bubble's side. */
const SIDE_OVERHANG = 10;
const RING = 2;

export interface ReactionBadgeProps {
  emoji: string;
  /** The bubble corner it sits on. */
  corner: "left" | "right";
  /** The colour around the badge: the page behind the bubble. */
  ring: string;
  onPress: () => void;
  reducedMotion: boolean;
}

export function ReactionBadge({ emoji, corner, ring, onPress, reducedMotion }: ReactionBadgeProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  // Opaque, so the bubble edge it straddles does not show through; a touch of the accent marks it as Isaac's.
  const fill = mixHex(dark ? colors.surfaceRaised : colors.surface, colors.accent, dark ? 0.22 : 0.12);
  return (
    <Animated.View
      key={emoji}
      entering={reducedMotion ? FadeIn.duration(160) : ZoomIn.springify().damping(12).stiffness(320).mass(0.6)}
      exiting={FadeOut.duration(120)}
      style={[styles.badge, corner === "right" ? { right: -SIDE_OVERHANG } : { left: -SIDE_OVERHANG }]}
    >
      <Pressable
        onPress={onPress}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Your reaction, ${emoji}`}
        accessibilityHint="Changes or removes it"
        style={[styles.disc, { backgroundColor: fill, borderColor: ring, shadowOpacity: dark ? 0 : 0.12 }]}
      >
        <Text style={styles.emoji}>{emoji}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  badge: { position: "absolute", top: -REACTION_BADGE_OVERHANG, zIndex: 1 },
  disc: {
    width: REACTION_BADGE_SIZE,
    height: REACTION_BADGE_SIZE,
    borderRadius: REACTION_BADGE_SIZE / 2,
    borderWidth: RING,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  emoji: { fontSize: 15, lineHeight: 19 },
});
