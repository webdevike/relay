/**
 * Wraps one chat bubble so it takes a reaction: holding it still opens the reaction overlay (a
 * medium haptic, then `onOpen` with where the bubble sits on screen), its reactions show as
 * `ReactionBadges` on its bottom-right corner (tapping one opens the overlay too; a reacted bubble
 * keeps a little room below it for them), and it hides while
 * the overlay draws its lifted copy. The hold is a gesture-handler long press that fails as soon
 * as the finger moves, so scrolling, swipes and taps on links, images and widgets inside the
 * bubble go on as before; once it fires it cancels them, so a held link does not also open.
 *
 * `style` takes the bubble's layout (alignSelf, maxWidth, margins); the bubble's own look stays on
 * its child, so the overlay can redraw the child at this exact width.
 *
 * VoiceOver: with `accessibilityLabel` the bubble is one element whose actions include React;
 * without (a bubble with links or widget controls VoiceOver must reach) it stays a container and
 * a React button follows its content.
 */
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type AccessibilityActionEvent, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useReducedMotion } from "react-native-reanimated";
import type { Rect } from "@/lib/bubbleMenu";
import { impactHaptic } from "@/lib/haptics";
import { ReactionBadges, reactionRoom, type BadgeReaction } from "@/ui/ReactionBadge";

/** Holding still this long (ms) opens the overlay; under the chat's action wheel hold, so on a bubble the overlay wins. */
export const BUBBLE_HOLD_MS = 300;

export interface ReactableBubbleProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Everyone's reactions on the bubble, left to right; empty for none. */
  reactions: readonly BadgeReaction[];
  /** No bubble of its own (a plain-text reply): the badges sit just under it rather than on its corner. */
  bare: boolean;
  /** False for a bubble that takes no reaction (a pending echo): it renders as a plain view. */
  enabled: boolean;
  /** The overlay is showing this bubble's lifted copy: the original steps aside. */
  lifted: boolean;
  /** The page colour around the bubble, for the badge's ring. */
  ring: string;
  /** The bubble as one VoiceOver element with this label; omit to keep its contents reachable. */
  accessibilityLabel?: string | undefined;
  onOpen: (bubble: Rect) => void;
}

export function ReactableBubble({ children, style, reactions, bare, enabled, lifted, ring, accessibilityLabel, onOpen }: ReactableBubbleProps) {
  const ref = useRef<View>(null);
  const reducedMotion = useReducedMotion();
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const open = useCallback(() => {
    ref.current?.measureInWindow((x, y, width, height) => {
      onOpenRef.current({ x, y, width, height });
    });
  }, []);
  const hold = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(BUBBLE_HOLD_MS)
        .enabled(enabled)
        .runOnJS(true)
        .onStart(() => {
          impactHaptic("medium");
          open();
        }),
    [enabled, open],
  );
  const grouped = enabled && accessibilityLabel !== undefined;
  const reacted = enabled && reactions.length > 0;
  const spoken = reactions.map(({ emoji, title }) => (title === null ? `Your reaction, ${emoji}` : `${title} reacted ${emoji}`));
  return (
    <GestureDetector gesture={hold}>
      <View
        ref={ref}
        collapsable={false}
        style={[style, reacted && { marginBottom: reactionRoom(bare) }, lifted && styles.lifted]}
        {...(grouped
          ? {
              accessible: true,
              accessibilityLabel: [accessibilityLabel, ...spoken].join(". "),
              accessibilityActions: [{ name: "react", label: "React" }],
              onAccessibilityAction: (event: AccessibilityActionEvent) => {
                if (event.nativeEvent.actionName === "react") open();
              },
            }
          : {})}
      >
        {children}
        {reacted && <ReactionBadges reactions={reactions} bare={bare} ring={ring} onPress={open} reducedMotion={reducedMotion} />}
        {enabled && !grouped && (
          <Pressable accessibilityRole="button" accessibilityLabel="React to this message" onPress={open} style={styles.voiceOverOnly} />
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  lifted: { opacity: 0 },
  // Invisible and untouchable by sight (1pt, no fill), but a VoiceOver element after the bubble's contents.
  voiceOverOnly: { position: "absolute", bottom: 0, left: 0, width: 1, height: 1 },
});
