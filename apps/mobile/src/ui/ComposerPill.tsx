import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector, type ComposedGesture, type GestureType } from "react-native-gesture-handler";
import Animated, { LinearTransition, ReduceMotion } from "react-native-reanimated";
import { spacing, useColors, useScheme } from "@/theme";

/** The round controls in the pill's row. */
export const COMPOSER_BUTTON = 40;
/** Inset of the controls from the pill's edge. */
const PAD = 6;
const GAP = spacing.sm;
const PILL_RADIUS = (COMPOSER_BUTTON + 2 * PAD) / 2;
const CARD_RADIUS = 26;
/** Opaque fill in dark mode, so the chat never reads through it. */
const FILL_DARK = "#262626";
const RESIZE = LinearTransition.duration(180).reduceMotion(ReduceMotion.System);

export interface ComposerPillProps {
  /** The two-row card (field on top, controls under it) instead of the one-line pill. */
  expanded: boolean;
  /** The text field. Never remounts between the shapes, so it keeps focus as the pill grows. */
  field: ReactNode;
  /** Left control (attach, or the x that cancels a dictation). */
  leading: ReactNode;
  /** After the leading control, only in the card (the assistant/model chip). */
  middle?: ReactNode;
  /** Right controls (mic and call, or the dictation's level, stop and send). */
  trailing: ReactNode;
  /** Above the field in the card: queued images, the paste chip. */
  header?: ReactNode;
  /** Gesture on the pill's open middle while collapsed: tap to type, hold to talk. */
  gesture?: ComposedGesture | GestureType;
  /** Covers the whole pill (hold-to-talk's live level and "Release to send"). */
  overlay?: ReactNode;
}

/**
 * A chat composer that floats over the conversation (after the Claude app's): collapsed, one
 * rounded pill of round controls around a one-line field; expanded (typing, a draft, a dictation),
 * a card with the field on top and the controls in a row under it. The field keeps its slot in
 * both shapes, laid over the row's open middle while collapsed, so it never loses focus.
 */
export function ComposerPill({ expanded, field, leading, middle, trailing, header, gesture, overlay }: ComposerPillProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const fill = dark ? FILL_DARK : colors.surface;
  const radius = expanded ? CARD_RADIUS : PILL_RADIUS;
  // The row's open middle (between the leading and trailing groups), for the collapsed field laid over it.
  const [row, setRow] = useState(0);
  const inert = useMemo(() => Gesture.Tap().enabled(false), []);
  const [span, setSpan] = useState({ x: COMPOSER_BUTTON + GAP, width: 0 });
  const open = { left: span.x, right: row > 0 ? row - span.x - span.width : 2 * COMPOSER_BUTTON + 2 * GAP };
  const onOpen = (event: LayoutChangeEvent): void => {
    const { x, width } = event.nativeEvent.layout;
    setSpan((current) => (current.x === x && current.width === width ? current : { x, width }));
  };
  return (
    <Animated.View layout={RESIZE} style={[styles.pill, { backgroundColor: fill, borderColor: colors.hairline, borderRadius: radius }, expanded ? styles.card : styles.collapsed]}>
      {expanded && header}
      <View pointerEvents={expanded ? "auto" : "none"} style={expanded ? styles.fieldCard : [styles.fieldPill, { left: PAD + open.left, right: PAD + open.right }]}>
        {field}
      </View>
      <View
        style={styles.row}
        onLayout={(event) => {
          setRow(event.nativeEvent.layout.width);
        }}
      >
        <View style={[styles.group, styles.lead]}>
          {leading}
          {expanded && middle}
        </View>
        <GestureDetector gesture={gesture ?? inert}>
          <View style={styles.open} onLayout={onOpen} />
        </GestureDetector>
        <View style={styles.group}>{trailing}</View>
      </View>
      {overlay !== undefined && <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: fill, borderRadius: radius }]}>{overlay}</View>}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: { borderWidth: StyleSheet.hairlineWidth, shadowColor: "#000000", shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
  collapsed: { padding: PAD },
  card: { padding: PAD + 2, paddingTop: PAD + 4 },
  fieldPill: { position: "absolute", top: 0, bottom: 0, justifyContent: "center" },
  fieldCard: { paddingHorizontal: spacing.xs, paddingBottom: spacing.xs },
  row: { flexDirection: "row", alignItems: "center" },
  group: { flexDirection: "row", alignItems: "center", gap: GAP },
  /** The leading group gives way first, so a long chip ellipsizes instead of pushing the buttons out. */
  lead: { flexShrink: 1, minWidth: 0 },
  open: { flex: 1, minWidth: GAP, alignSelf: "stretch" },
  overlay: { alignItems: "center", justifyContent: "center", flexDirection: "row", gap: spacing.md },
});
