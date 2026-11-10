import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import {
  Gesture,
  GestureDetector,
  type ComposedGesture,
  type GestureType,
} from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { spacing, useColors, useScheme } from "@/theme";

/** The round controls in the pill's row. */
export const COMPOSER_BUTTON = 40;
/** Inset of the controls from the pill's edge, in both shapes, so they never move when it grows. */
const PAD = 6;
const GAP = spacing.sm;
const BORDER = StyleSheet.hairlineWidth;
/** Inside height of the idle pill: one row of controls. */
const PILL_INNER = COMPOSER_BUTTON + 2 * PAD;
/** The idle pill's full height, borders included (what the screen reserves under the list). */
export const COMPOSER_PILL_HEIGHT = PILL_INNER + 2 * BORDER;
/** Half the idle pill: a capsule, and the card keeps the same corners. */
const RADIUS = PILL_INNER / 2 + BORDER;
/** Opaque fill in dark mode, so the chat never reads through it. */
const FILL_DARK = "#262626";

/**
 * The text field's metrics. The field uses them in both shapes, so its text never changes size or
 * padding when the pill opens; only where the field sits moves.
 */
export const COMPOSER_FIELD = {
  line: 22,
  padTop: 4,
  padBottom: 8,
  min: 44,
  max: 22 * 5 + 12,
} as const;
/** Text inset of the field from the card's sides. */
const FIELD_X = PAD + spacing.xs;
/** Bottom of the field in the card: on top of the controls row. */
const FIELD_BOTTOM = PAD + COMPOSER_BUTTON;
/** Bottom of the field in the pill: its first line centred on the row (it may hang below the pill; the pill clips it). */
const FIELD_BOTTOM_IDLE =
  PILL_INNER / 2 - (COMPOSER_FIELD.min - COMPOSER_FIELD.padTop - COMPOSER_FIELD.line / 2);

/**
 * Opening and closing ride along with the iOS keyboard: about its duration, on a curve close to its
 * own, started in the same frame as the focus that raises it. A line typed into the open card grows
 * it faster, so the new line is never clipped for long.
 */
const OPEN = {
  duration: 320,
  easing: Easing.bezier(0.38, 0.7, 0.125, 1),
  reduceMotion: ReduceMotion.System,
};
const GROW = { duration: 140, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.System };

export interface ComposerPillProps {
  /** The two-row card (field on top, controls under it) instead of the one-line pill. */
  expanded: boolean;
  /** The text field. One instance in both shapes: it never remounts, so it keeps focus as the pill grows. */
  field: ReactNode;
  /** Left control (attach, or the x that cancels a dictation). */
  leading: ReactNode;
  /** After the leading control, only in the card (the assistant/model chip). */
  middle?: ReactNode;
  /** Right controls (mic and call, or the dictation's level, stop and send). */
  trailing: ReactNode;
  /** Above the field in the card: queued images. */
  header?: ReactNode;
  /** Gesture on the pill's open middle while collapsed: tap to type, hold to talk. */
  gesture?: ComposedGesture | GestureType;
  /** Covers the whole pill (hold-to-talk's live level and "Release to send"). */
  overlay?: ReactNode;
  /**
   * The pill's height on screen, frame by frame (starts at `COMPOSER_PILL_HEIGHT`): the screen pads
   * its list by it on the UI thread, so the newest message rises with the card instead of jumping.
   */
  height: SharedValue<number>;
}

/**
 * A chat composer that floats over the conversation (after the Claude app's): collapsed, one
 * rounded pill of round controls around a one-line field; expanded (typing, a draft, a dictation),
 * a card with the field on top and the controls in a row under it.
 *
 * The shape change runs on the UI thread with no layout jump: the controls row stays pinned to the
 * bottom (same inset in both shapes), the card's top edge rises with an animated height, and the
 * field glides from the row's open middle to its place above the row in the same motion. Nothing
 * remounts and nothing swaps styles, so neither the field nor the buttons flicker.
 */
export function ComposerPill({
  expanded,
  field,
  leading,
  middle,
  trailing,
  header,
  gesture,
  overlay,
  height,
}: ComposerPillProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const fill = dark ? FILL_DARK : colors.surface;
  const inert = useMemo(() => Gesture.Tap().enabled(false), []);

  // The row's open middle (between the leading and trailing groups): where the idle field sits.
  const [row, setRow] = useState(0);
  const [span, setSpan] = useState({ x: COMPOSER_BUTTON + GAP, width: 0 });
  const idleLeft = PAD + span.x;
  const idleRight = PAD + (row > 0 ? row - span.x - span.width : 2 * COMPOSER_BUTTON + 2 * GAP);
  const onOpen = (event: LayoutChangeEvent): void => {
    const { x, width } = event.nativeEvent.layout;
    setSpan((current) => (current.x === x && current.width === width ? current : { x, width }));
  };

  // The card's height follows the field (it grows with each line, up to five) and the queued images.
  const [fieldHeight, setFieldHeight] = useState<number>(COMPOSER_FIELD.min);
  const [headerHeight, setHeaderHeight] = useState(0);
  const inner = expanded
    ? FIELD_BOTTOM + fieldHeight + PAD + (header === undefined ? 0 : headerHeight)
    : PILL_INNER;

  const progress = useSharedValue(expanded ? 1 : 0);
  const shown = useRef<{ expanded: boolean; inner: number } | null>(null);
  // Layout effect: the animation starts in the commit that changes the shape, not a frame later.
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { expanded, inner };
    const target = inner + 2 * BORDER;
    if (before === null) {
      progress.value = expanded ? 1 : 0;
      height.value = target;
      return;
    }
    if (before.expanded !== expanded) {
      progress.value = withTiming(expanded ? 1 : 0, OPEN);
      height.value = withTiming(target, OPEN);
    } else if (before.inner !== inner) {
      height.value = withTiming(target, GROW);
    }
  }, [expanded, inner, progress, height]);

  const pillStyle = useAnimatedStyle(() => ({ height: height.value }));
  const fieldStyle = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      left: idleLeft + (FIELD_X - idleLeft) * p,
      right: idleRight + (FIELD_X - idleRight) * p,
      bottom: FIELD_BOTTOM_IDLE + (FIELD_BOTTOM - FIELD_BOTTOM_IDLE) * p,
    };
  });

  return (
    <Animated.View
      style={[
        styles.pill,
        { backgroundColor: fill, borderColor: colors.hairline, borderRadius: RADIUS },
        pillStyle,
      ]}
    >
      <View style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: RADIUS - BORDER }]}>
        {expanded && header !== undefined && (
          <View
            style={[styles.header, { bottom: FIELD_BOTTOM + fieldHeight }]}
            onLayout={(event) => {
              setHeaderHeight(event.nativeEvent.layout.height);
            }}
          >
            {header}
          </View>
        )}
        <Animated.View
          pointerEvents={expanded ? "auto" : "none"}
          style={[styles.field, fieldStyle]}
          onLayout={(event) => {
            const next = Math.round(event.nativeEvent.layout.height);
            setFieldHeight((current) => (current === next ? current : next));
          }}
        >
          {field}
        </Animated.View>
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
        {overlay !== undefined && (
          <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: fill }]}>
            {overlay}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderWidth: BORDER,
    shadowColor: "#000000",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
  },
  clip: { overflow: "hidden" },
  header: { position: "absolute", left: PAD, right: PAD, paddingHorizontal: spacing.xs },
  field: { position: "absolute" },
  /** Pinned to the bottom with the same inset in both shapes: the buttons never move. */
  row: {
    position: "absolute",
    left: PAD,
    right: PAD,
    bottom: PAD,
    height: COMPOSER_BUTTON,
    flexDirection: "row",
    alignItems: "center",
  },
  group: { flexDirection: "row", alignItems: "center", gap: GAP },
  /** The leading group gives way first, so a long chip ellipsizes instead of pushing the buttons out. */
  lead: { flexShrink: 1, minWidth: 0 },
  open: { flex: 1, minWidth: GAP, alignSelf: "stretch" },
  overlay: {
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
});
