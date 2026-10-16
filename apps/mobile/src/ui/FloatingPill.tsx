import type { ReactNode } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { spacing, useColors, useScheme } from "@/theme";

/** Resting height of the pill; a multiline field grows it. */
export const PILL_HEIGHT = 48;
/** Minimum height of the expanded card. */
const CARD_MIN_HEIGHT = 120;
/** One line of the field's 17pt text. */
const LINE_HEIGHT = 22;
/** Vertical padding of the field above and below the text; the reported content height includes both. */
const FIELD_PADDING_Y = 13;
/** Room a multiline field grows to before it scrolls: about five lines. */
const MAX_FIELD_HEIGHT = LINE_HEIGHT * 5 + 2 * FIELD_PADDING_Y;
/** Opaque pill fill in dark mode, so the list never reads through it. */
const FILL_DARK = "#202020";

/** Number of text lines in a field whose content (padding included) is `contentHeight` tall. */
function lineCount(contentHeight: number): number {
  return Math.max(1, Math.round((contentHeight - 2 * FIELD_PADDING_Y) / LINE_HEIGHT));
}

export interface FloatingPillProps {
  /** Control at the left edge: beside the field when collapsed, bottom-left of the card when expanded. */
  leading?: ReactNode;
  /** Control at the right edge: beside the field when collapsed, bottom-right of the card when expanded. */
  trailing?: ReactNode;
  /** Grow from a one-line pill into a tall card with the field on top and the controls in a bottom row. */
  expanded?: boolean;
  /** The field between the controls; `FloatingPillInput`. */
  children: ReactNode;
}

/**
 * A full-width rounded bar that floats over a scrolling page: opaque #202020 in dark mode,
 * the surface colour in light. No hairline, no shadow. The element tree is the same collapsed and
 * expanded (only styles change), so a focused field keeps focus while the bar grows.
 */
export function FloatingPill({ leading, trailing, expanded = false, children }: FloatingPillProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: dark ? FILL_DARK : colors.surface },
        expanded ? styles.pillExpanded : styles.pillCollapsed,
      ]}
    >
      {leading !== undefined && <View style={[styles.slot, expanded && styles.slotLeft]}>{leading}</View>}
      <View style={[styles.field, expanded && styles.fieldExpanded]}>{children}</View>
      {trailing !== undefined && <View style={[styles.slot, expanded && styles.slotRight]}>{trailing}</View>}
    </View>
  );
}

export interface FloatingPillInputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string | undefined;
  editable?: boolean;
  accessibilityLabel?: string;
  /** Taller minimum height, for a field inside an expanded pill. */
  tall?: boolean;
  /** Called with the number of lines the text takes whenever it changes. */
  onLines?: (lines: number) => void;
  /** Called when the field takes focus. */
  onFocus?: () => void;
}

/** The borderless multiline text field that lives inside a `FloatingPill`. */
export function FloatingPillInput({ value, onChangeText, placeholder, editable = true, accessibilityLabel, tall = false, onLines, onFocus }: FloatingPillInputProps) {
  const colors = useColors();
  const scheme = useScheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textFaint}
      multiline
      editable={editable}
      keyboardAppearance={scheme}
      selectionColor={colors.accent}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      onFocus={onFocus}
      onContentSizeChange={(event) => {
        onLines?.(lineCount(event.nativeEvent.contentSize.height));
      }}
      style={{
        minHeight: tall ? CARD_MIN_HEIGHT - PILL_HEIGHT : PILL_HEIGHT,
        maxHeight: MAX_FIELD_HEIGHT,
        paddingTop: FIELD_PADDING_Y,
        paddingBottom: FIELD_PADDING_Y,
        paddingHorizontal: spacing.xs,
        color: colors.text,
        fontSize: 17,
        opacity: editable ? 1 : 0.5,
      }}
    />
  );
}

const styles = StyleSheet.create({
  pill: { borderRadius: PILL_HEIGHT / 2, minHeight: PILL_HEIGHT, flexDirection: "row", alignItems: "flex-end" },
  pillCollapsed: { paddingHorizontal: spacing.md - 2, gap: spacing.xs },
  pillExpanded: { minHeight: CARD_MIN_HEIGHT, borderRadius: 24 },
  slot: { height: PILL_HEIGHT, justifyContent: "center" },
  slotLeft: { position: "absolute", left: spacing.md - 2, bottom: 0 },
  slotRight: { position: "absolute", right: spacing.md - 2, bottom: 0 },
  field: { flex: 1 },
  fieldExpanded: { paddingHorizontal: spacing.md, paddingBottom: PILL_HEIGHT },
});
