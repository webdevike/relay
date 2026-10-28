/**
 * Reactions on a chat bubble, iMessage style but at the bubble's bottom-right corner, for both
 * sides: a row of small badges straddling the corner (`ReactionBadges`), ringed in the page colour
 * so they read as sitting on the bubble's edge. Isaac's is a round disc, outermost on the corner;
 * each assistant's sits to its left as a pill with its tiny portrait and emoji (just the emoji
 * before the host has listed the assistant). Each pops in when it lands (a fade with Reduce Motion)
 * and, tapped, opens the bubble's reaction overlay.
 *
 * A bubble without a bubble of its own (`bare`: a plain-text reply) keeps its badges just under
 * its bottom-right instead, so they never sit on its words.
 */
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn } from "react-native-reanimated";
import type { AssistantPortrait } from "@relay/protocol";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";
import { mixHex, useColors, useScheme } from "@/theme";

const REACTION_BADGE_SIZE = 30;
/**
 * How far a badge reaches below the bubble's bottom edge: it overlaps the bubble by 8 pt, inside
 * the padding of every bubble (so never over its text or an image in it). A reacted bubble keeps
 * a little more room than this below it, clear of the receipt or the next bubble.
 */
const OVERHANG = REACTION_BADGE_SIZE - 8;
/** How far it sticks out past the bubble's right side. */
const SIDE_OVERHANG = 8;
/** Under a bare reply: the gap between its last line and the badges. */
const BARE_GAP = 4;
const RING = 2;
const PORTRAIT_SIZE = 20;
/** Room a reacted bubble keeps below it, so its badges clear what follows. */
export function reactionRoom(bare: boolean): number {
  return (bare ? REACTION_BADGE_SIZE + BARE_GAP : OVERHANG) + 4;
}

/** One badge: Isaac's (`title` null) or an assistant's, with its portrait (null before the host listed it). */
export interface BadgeReaction {
  reactor: string;
  emoji: string;
  title: string | null;
  portrait: AssistantPortrait | null;
}

export interface ReactionBadgesProps {
  /** Left to right; Isaac's last (`lib/reactions` `bubbleReactions`). */
  reactions: readonly BadgeReaction[];
  bare: boolean;
  /** The colour around the badges: the page behind the bubble. */
  ring: string;
  onPress: () => void;
  reducedMotion: boolean;
}

export function ReactionBadges({ reactions, bare, ring, onPress, reducedMotion }: ReactionBadgesProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  // Opaque, so the bubble edge it straddles does not show through; a touch of the accent marks Isaac's.
  const base = dark ? colors.surfaceRaised : colors.surface;
  const isaacFill = mixHex(base, colors.accent, dark ? 0.22 : 0.12);
  return (
    <View pointerEvents="box-none" style={[styles.row, bare ? styles.bare : styles.corner]}>
      {reactions.map(({ reactor, emoji, title, portrait }) => (
        <Animated.View
          key={`${reactor}:${emoji}`}
          entering={reducedMotion ? FadeIn.duration(160) : ZoomIn.springify().damping(12).stiffness(320).mass(0.6)}
          exiting={FadeOut.duration(120)}
        >
          <Pressable
            onPress={onPress}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={title === null ? `Your reaction, ${emoji}` : `${title} reacted ${emoji}`}
            accessibilityHint={title === null ? "Changes or removes it" : "Opens reactions"}
            style={[
              styles.badge,
              portrait !== null && styles.pill,
              { backgroundColor: title === null ? isaacFill : base, borderColor: ring, shadowOpacity: dark ? 0 : 0.12 },
            ]}
          >
            {portrait !== null && (
              <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Portrait name={title ?? reactor} portrait={portrait} size={PORTRAIT_SIZE} />
              </View>
            )}
            <Text style={styles.emoji}>{emoji}</Text>
          </Pressable>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { position: "absolute", zIndex: 1, flexDirection: "row", alignItems: "center", gap: 2 },
  corner: { right: -SIDE_OVERHANG, bottom: -OVERHANG },
  bare: { right: 0, bottom: -(REACTION_BADGE_SIZE + BARE_GAP) },
  badge: {
    minWidth: REACTION_BADGE_SIZE,
    height: REACTION_BADGE_SIZE,
    borderRadius: REACTION_BADGE_SIZE / 2,
    borderWidth: RING,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  pill: { gap: 3, paddingLeft: 2, paddingRight: 6 },
  emoji: { fontSize: 15, lineHeight: 19 },
});
