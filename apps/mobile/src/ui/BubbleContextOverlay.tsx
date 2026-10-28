/**
 * The long-press overlay of a chat bubble, after iMessage: the screen blurs and dims, the bubble
 * lifts in place (scaled a touch, with a shadow), the `ReactionBar` floats above it and a
 * `MessageMenu` sits below it. Near the top or bottom of the screen the bubble slides just enough
 * for both to fit; a bubble taller than the room is clipped to it (`lib/bubbleMenu.ts`
 * `overlayPlacement`). A tap outside, VoiceOver's escape, or any action closes it. With Reduce
 * Motion nothing scales or springs; it only fades.
 *
 * Render it as the last child of a view filling the screen; it measures its own place in the
 * window, so `bubble` is in window coordinates (`ReactableBubble`'s `onOpen`).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { BlurView } from "expo-blur";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { overlayPlacement, type Rect } from "@/lib/bubbleMenu";
import { useScheme, withAlpha } from "@/theme";
import { MESSAGE_MENU_WIDTH, MessageMenu, messageMenuHeight, type MessageMenuAction } from "@/ui/MessageMenu";
import { REACTION_BAR_SIZE, ReactionBar } from "@/ui/ReactionBar";

const LIFT = 1.03;
const GAP = 10;
const MARGIN = 12;
const SPRING = { damping: 18, stiffness: 280, mass: 0.7 } as const;

export interface BubbleContextOverlayProps {
  /** Where the bubble sits, in window coordinates. */
  bubble: Rect;
  /** The edge the bubble hugs; the bar and menu line up with it. */
  side: "left" | "right";
  /** The bubble drawn again, at `bubble`'s width, as the lifted copy. */
  lifted: ReactNode;
  /** The bubble's corner radius, kept when a tall bubble is clipped. */
  radius: number;
  /**
   * A card behind the lifted copy, for a reply drawn without a bubble of its own (a regular
   * session's plain text): its fill, corner radius and how far it reaches past the text.
   */
  card?: { fill: string; radius: number; inset: number } | undefined;
  /** The bubble's reaction, highlighted in the bar. */
  reaction: string | null;
  onReact: (emoji: string) => void;
  onMore: () => void;
  actions: readonly MessageMenuAction[];
  onClose: () => void;
}

export function BubbleContextOverlay({ bubble, side, lifted, radius, card, reaction, onReact, onMore, actions, onClose }: BubbleContextOverlayProps) {
  const scheme = useScheme();
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const root = useRef<View>(null);
  // The overlay's own place in the window; nothing draws until it is known.
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const placement = overlayPlacement({
    bubble: { ...bubble, x: bubble.x - (origin?.x ?? 0), y: bubble.y - (origin?.y ?? 0) },
    screen,
    insets,
    side,
    bar: REACTION_BAR_SIZE,
    menu: { width: MESSAGE_MENU_WIDTH, height: messageMenuHeight(actions.length) },
    lift: reducedMotion ? 1 : LIFT,
    gap: GAP,
    margin: MARGIN,
  });
  const scale = useSharedValue(1);
  const target = placement.scale;
  useEffect(() => {
    scale.value = reducedMotion ? target : withSpring(target, SPRING);
  }, [scale, target, reducedMotion]);
  const lift = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      ref={root}
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(140)}
      style={StyleSheet.absoluteFill}
      onLayout={() => {
        root.current?.measureInWindow((x, y) => {
          setOrigin({ x, y });
        });
      }}
      accessibilityViewIsModal
      onAccessibilityEscape={onClose}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
        <BlurView intensity={24} tint={scheme} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha("#000000", scheme === "dark" ? 0.4 : 0.16) }]} />
      </Pressable>
      {origin !== null && (
        <>
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.lifted,
              { left: placement.bubble.x, top: placement.bubble.y, width: placement.bubble.width, height: placement.bubble.height },
              lift,
            ]}
          >
            {card !== undefined && (
              <View
                style={[
                  styles.card,
                  { top: -card.inset, bottom: -card.inset, left: -card.inset, right: -card.inset, backgroundColor: card.fill, borderRadius: card.radius },
                ]}
              />
            )}
            <View style={[styles.clip, { borderRadius: radius }]}>
              <View style={{ width: bubble.width, transform: [{ translateY: -placement.contentOffset }] }}>{lifted}</View>
            </View>
          </Animated.View>
          <View style={[styles.anchored, { left: placement.bar.x, top: placement.bar.y }]}>
            <ReactionBar current={reaction} onPick={onReact} onMore={onMore} anchor={side} reducedMotion={reducedMotion} />
          </View>
          <View style={[styles.anchored, { left: placement.menu.x, top: placement.menu.y }]}>
            <MessageMenu actions={actions} anchor={side} reducedMotion={reducedMotion} />
          </View>
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  lifted: {
    position: "absolute",
    shadowColor: "#000000",
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  card: { position: "absolute", borderCurve: "continuous" },
  // Clips only a bubble taller than the room, keeping the bubble's corners.
  clip: { flex: 1, overflow: "hidden" },
  anchored: { position: "absolute" },
});
