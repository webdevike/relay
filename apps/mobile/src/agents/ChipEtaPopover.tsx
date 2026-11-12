import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { FadeInUp, FadeOut, ReduceMotion } from "react-native-reanimated";
import { motion, spacing, useColors, useScheme } from "@/theme";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { popoverLeft, popoverWidth } from "@/ui/sliderMath";
import type { PopoverAnchor } from "@/agents/ThinkingPopover";

/** Same opaque fill as `ThinkingPopover`'s card in dark mode. */
const FILL_DARK = "#262626";
const CARD_RADIUS = 22;
const MAX_WIDTH = 280;
/** Gap between the chip's bottom edge and the card. */
const ANCHOR_GAP = 8;

export interface ChipEtaPopoverProps {
  /** Window coordinates of the chip from `measureInWindow`; null = hidden. */
  anchor: PopoverAnchor | null;
  /** The estimate's line ("About 12 min left"). */
  label: string;
  /** Muted under it ("Rough guess · 34 similar runs"). */
  detail: string;
  /** Opens what tapping the chip opened before the estimate was shown first. */
  onOpen: () => void;
  onClose: () => void;
}

const ENTER = FadeInUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System);
const EXIT = FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System);

/**
 * A small card under a running chip that has an estimate: what is left, how sure that is, and an
 * Open action. Its own transparent `Modal`, so window coordinates from `measureInWindow` place it
 * even though the chip sits in a header; a tap outside closes it.
 */
export function ChipEtaPopover({ anchor, label, detail, onOpen, onClose }: ChipEtaPopoverProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const window = useWindowDimensions();
  const width = popoverWidth(window.width, spacing.md, MAX_WIDTH);
  return (
    <Modal visible={anchor !== null} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      {anchor !== null && (
        <>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close estimate" />
          <Animated.View
            entering={ENTER}
            exiting={EXIT}
            accessibilityViewIsModal
            style={[styles.card, { left: popoverLeft(anchor.x, width, window.width, spacing.md), top: anchor.y + anchor.height + ANCHOR_GAP, width, backgroundColor: dark ? FILL_DARK : colors.surface, borderColor: colors.hairline }]}
          >
            <Text variant="body" style={styles.label}>
              {label}
            </Text>
            <Text variant="caption" color="textMuted">
              {detail}
            </Text>
            <View style={styles.action}>
              <Button label="Open" variant="secondary" onPress={onOpen} />
            </View>
          </Animated.View>
        </>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    borderRadius: CARD_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.xs,
    shadowColor: "#000000",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
  },
  label: { fontWeight: "500" },
  action: { marginTop: spacing.sm },
});
