import type { ReactNode } from "react";
import { Pressable, type Insets } from "react-native";
import { Text } from "./Text";
import { spacing, toneFill, useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

const HEIGHT = 28;
/** Long labels (a shell command) stop here and end in an ellipsis. */
const MAX_WIDTH = 200;

export interface ChipProps {
  label: string;
  /** Glyph or spinner before the label. */
  leading?: ReactNode;
  /** Accent outline and fill: the chip whose details are showing. */
  selected?: boolean;
  onPress: () => void;
  accessibilityLabel?: string | undefined;
  /** Extra touch area around the capsule, e.g. to reach a 44pt target in a chat. */
  hitSlop?: Insets;
}

/** A small tappable capsule in a row of chips: optional leading glyph, one-line label. */
export function Chip({ label, leading, selected = false, onPress, accessibilityLabel, hitSlop }: ChipProps) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={hitSlop}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        height: HEIGHT,
        maxWidth: MAX_WIDTH,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs,
        paddingHorizontal: spacing.md,
        borderRadius: HEIGHT / 2,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.hairline,
        backgroundColor: selected ? toneFill(colors, "accent", 0.12) : colors.surfaceRaised,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {leading}
      <Text variant="caption" color={selected ? "accent" : "text"} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </Text>
    </Pressable>
  );
}
