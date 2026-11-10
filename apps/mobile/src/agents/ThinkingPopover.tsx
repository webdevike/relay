import { useEffect, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { FadeInDown, FadeOut, ReduceMotion } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { motion, spacing, useColors, useScheme } from "@/theme";
import { Text } from "@/ui/Text";
import { DotSlider } from "@/ui/DotSlider";
import { popoverLeft, popoverWidth } from "@/ui/sliderMath";
import { tapHaptic } from "@/lib/haptics";

/** Same opaque fill as the composer pill in dark mode. */
const FILL_DARK = "#262626";
const CARD_RADIUS = 22;
const MAX_WIDTH = 340;
/** Gap between the card's bottom edge and the chip it grows from. */
const ANCHOR_GAP = 8;
const RESET = 28;

export interface PopoverAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ThinkingPopoverProps {
  /** Window coordinates from `measureInWindow`; null = hidden. */
  anchor: PopoverAnchor | null;
  /** "Opus 5.5" (already shortened by the caller). */
  model: string;
  /** The model's levels, low to high, e.g. ["off","low","medium","high","xhigh","max"]. */
  levels: readonly string[];
  /** The session's current level (undefined when unknown: the slider starts at the first level and there is no reset). */
  current: string | undefined;
  /** Called once per committed change to a level different from `current`. */
  onSelect: (level: string) => void;
  onClose: () => void;
}

const ENTER = FadeInDown.duration(motion.duration.fast).reduceMotion(ReduceMotion.System);
const EXIT = FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System);

function capitalized(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/**
 * A compact popover above the composer's model chip: the model, the current thinking level in
 * words and a dot slider over the model's levels. A committed level goes to `onSelect` and the
 * card stays open so the change is seen landing; a tap outside closes it. Render it last inside a
 * full-screen container (it fills it, and its backdrop takes the touches).
 */
export function ThinkingPopover({ anchor, ...rest }: ThinkingPopoverProps) {
  if (anchor === null) return null;
  return <PopoverLayer anchor={anchor} {...rest} />;
}

function PopoverLayer({ anchor, model, levels, current, onSelect, onClose }: ThinkingPopoverProps & { anchor: PopoverAnchor }) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const window = useWindowDimensions();
  const known = current === undefined ? -1 : levels.indexOf(current);
  // Where the slider sat when the popover opened; reset returns there.
  const [opened] = useState(Math.max(0, known));
  const [index, setIndex] = useState(Math.max(0, known));

  // The session reports a different level than the slider shows (set elsewhere): follow it.
  useEffect(() => {
    if (known >= 0) setIndex(known);
  }, [known]);

  const width = popoverWidth(window.width, spacing.md, MAX_WIDTH);
  const left = popoverLeft(anchor.x, width, window.width, spacing.md);
  const bottom = window.height - anchor.y + ANCHOR_GAP;
  const level = levels[index] ?? "";
  const canReset = known >= 0 && index !== opened;

  const commit = (next: number): void => {
    const picked = levels[next];
    if (picked !== undefined && picked !== current) onSelect(picked);
  };
  const reset = (): void => {
    tapHaptic();
    setIndex(opened);
    commit(opened);
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close thinking level" />
      <Animated.View
        entering={ENTER}
        exiting={EXIT}
        accessibilityViewIsModal
        accessibilityLabel={`${model} thinking`}
        style={[styles.card, { left, bottom, width, backgroundColor: dark ? FILL_DARK : colors.surface, borderColor: colors.hairline }]}
      >
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {model}
        </Text>
        <View style={styles.head}>
          <Text variant="body" style={styles.label} accessibilityElementsHidden importantForAccessibility="no">
            {capitalized(level)}
          </Text>
          <Pressable
            onPress={reset}
            disabled={!canReset}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={`Reset to ${capitalized(levels[opened] ?? "")}`}
            accessibilityElementsHidden={!canReset}
            importantForAccessibility={canReset ? "yes" : "no-hide-descendants"}
            style={[styles.reset, { opacity: canReset ? 1 : 0 }]}
          >
            <SymbolView name="arrow.counterclockwise" size={15} tintColor={colors.textMuted} />
          </Pressable>
        </View>
        <DotSlider
          steps={levels.map(capitalized)}
          index={index}
          onChange={setIndex}
          onCommit={commit}
          accessibilityLabel="Thinking level"
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    borderRadius: CARD_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
    shadowColor: "#000000",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
  },
  head: { height: RESET, justifyContent: "center" },
  reset: { position: "absolute", right: 0, width: RESET, height: RESET, alignItems: "center", justifyContent: "center" },
  label: { textAlign: "center", fontWeight: "500" },
});
