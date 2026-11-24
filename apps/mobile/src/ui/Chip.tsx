import type { ReactNode } from "react";
import { Pressable, type AccessibilityActionEvent, type AccessibilityActionInfo, type Insets, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "./Text";
import { spacing, toneFill, useColors } from "@/theme";
import { impactHaptic, tapHaptic } from "@/lib/haptics";

/** The capsule's fixed height, for a row of chips that must not change height. */
export const CHIP_HEIGHT = 28;
/** Height of a `large` chip, level with a composer's 40pt round buttons. */
const CHIP_HEIGHT_LARGE = 40;
/** Long labels (a shell command) stop here and end in an ellipsis. */
const MAX_WIDTH = 200;

export interface ChipProps {
  label: string;
  /** Glyph or spinner before the label. */
  leading?: ReactNode;
  /** Accent outline and fill: the chip whose details are showing. */
  selected?: boolean;
  onPress: () => void;
  /** A held press: fires with a medium haptic instead of `onPress`. */
  onLongPress?: () => void;
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string;
  /** Custom VoiceOver actions (e.g. dismiss), handled by `onAccessibilityAction`. */
  accessibilityActions?: readonly AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  /** Extra touch area around the capsule, e.g. to reach a 44pt target in a chat. */
  hitSlop?: Insets;
  /** Layout in its row, e.g. `{ flexShrink: 1, minWidth: 0 }` so the label ellipsizes to fit. */
  style?: StyleProp<ViewStyle>;
  /** Light text on a dark capsule, for chrome over media (the Studio editor). */
  overlay?: boolean;
  /** Muted words after the label, e.g. a model's thinking level. */
  detail?: string | undefined;
  /** `large`: a 40pt borderless capsule with body text, for a composer's control row. */
  size?: "regular" | "large";
}

/** A small tappable capsule in a row of chips: optional leading glyph, one-line label. */
export function Chip({ label, detail, leading, selected = false, onPress, onLongPress, accessibilityLabel, accessibilityHint, accessibilityActions, onAccessibilityAction, hitSlop, style, overlay = false, size = "regular" }: ChipProps) {
  const large = size === "large";
  const height = large ? CHIP_HEIGHT_LARGE : CHIP_HEIGHT;
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      hitSlop={hitSlop}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      onLongPress={
        onLongPress === undefined
          ? undefined
          : () => {
              impactHaptic();
              onLongPress();
            }
      }
      style={({ pressed }) => [
        {
          height,
          maxWidth: large ? undefined : MAX_WIDTH,
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.xs,
          paddingHorizontal: large ? spacing.lg : spacing.md,
          borderRadius: height / 2,
          borderWidth: large ? 0 : 1,
          borderColor: selected ? colors.accent : overlay ? "#2C2E33" : colors.hairline,
          backgroundColor: selected ? toneFill(colors, "accent", 0.12) : overlay ? "#1A1B1E" : colors.surfaceRaised,
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {leading}
      <Text variant={large ? "body" : "caption"} color={selected ? "accent" : "text"} numberOfLines={1} style={[{ flexShrink: 1 }, overlay && !selected && { color: "#E9ECEF" }]}>
        {label}
        {detail !== undefined && <Text variant={large ? "body" : "caption"} color="textMuted">{` ${detail}`}</Text>}
      </Text>
    </Pressable>
  );
}
