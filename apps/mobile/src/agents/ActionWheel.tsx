import { StyleSheet, View } from "react-native";
import Animated, { interpolateColor, useAnimatedReaction, useAnimatedStyle, useDerivedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { colors, motion } from "@/theme";
import { selectHaptic } from "@/lib/haptics";

/** Radius (pt) from the press point to the entries. */
const RING_RADIUS = 92;
/** Inside this radius (pt) of the press point nothing is highlighted; lifting here cancels. */
const DEAD_ZONE = 28;
/** Half-size of the disc; the entries sit well inside it. */
export const ACTION_WHEEL_EXTENT = RING_RADIUS + 38;
const ENTRY_WIDTH = 76;
const ICON_SIZE = 24;
const TOP = -Math.PI / 2;
/** 0.92 opacity on the raised surface. */
const DISC_COLOR = `${colors.surfaceRaised}EB`;

export interface ActionWheelEntry {
  key: string;
  label: string;
  symbol: SFSymbol;
}

export interface ActionWheelProps {
  entries: ActionWheelEntry[];
  /** 1 while the finger is down on the wheel. Dropping it to 0 is the release: the highlighted entry, if any, is selected. */
  visible: SharedValue<number>;
  /** The press point, in the parent's coordinates. */
  center: SharedValue<{ x: number; y: number }>;
  /** Where the finger is now, in the parent's coordinates. Put it on `center` to release with nothing selected. */
  pointer: SharedValue<{ x: number; y: number }>;
  onSelect: (key: string) => void;
}

/** The entry whose sector the finger is in, or -1 inside the dead zone. Sectors are centered on the entries, the first at the top. */
function entryUnder(count: number, dx: number, dy: number): number {
  "worklet";
  if (count === 0 || dx * dx + dy * dy < DEAD_ZONE * DEAD_ZONE) return -1;
  const step = (2 * Math.PI) / count;
  const turn = (((Math.atan2(dy, dx) - TOP) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(turn / step) % count;
}

/**
 * Full-circle radial menu under a held finger. The parent owns the long-press-then-pan gesture and
 * feeds the press point and the finger through shared values; this only draws and decides. A
 * dark disc centered on the press point carries the entries around a ring; past the dead zone the
 * finger's sector lights its entry (a tick on every change), and the release picks it.
 */
export function ActionWheel({ entries, visible, center, pointer, onSelect }: ActionWheelProps) {
  const highlighted = useDerivedValue(() => entryUnder(entries.length, pointer.value.x - center.value.x, pointer.value.y - center.value.y));
  const keys = entries.map((entry) => entry.key);

  useAnimatedReaction(
    () => highlighted.value,
    (index, previous) => {
      if (index >= 0 && index !== previous) scheduleOnRN(selectHaptic);
    },
  );
  useAnimatedReaction(
    () => visible.value,
    (shown, previous) => {
      if (shown !== 0 || previous !== 1) return;
      const key = keys[highlighted.value];
      if (key !== undefined) scheduleOnRN(onSelect, key);
    },
  );

  const discStyle = useAnimatedStyle(() => ({
    opacity: withTiming(visible.value, { duration: motion.duration.base }),
    transform: [
      { translateX: center.value.x - ACTION_WHEEL_EXTENT },
      { translateY: center.value.y - ACTION_WHEEL_EXTENT },
      { scale: withTiming(visible.value === 0 ? 0.88 : 1, { duration: motion.duration.base }) },
    ],
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.disc, discStyle]}>
      <View style={styles.deadZone} />
      {entries.map((entry, index) => (
        <Entry key={entry.key} entry={entry} angle={TOP + (index * 2 * Math.PI) / entries.length} lit={highlighted} index={index} />
      ))}
    </Animated.View>
  );
}

function Entry({ entry, angle, lit, index }: { entry: ActionWheelEntry; angle: number; lit: SharedValue<number>; index: number }) {
  const active = useDerivedValue(() => withTiming(lit.value === index ? 1 : 0, { duration: motion.duration.fast }));
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: RING_RADIUS * Math.cos(angle) }, { translateY: RING_RADIUS * Math.sin(angle) }, { scale: 1 + 0.14 * active.value }],
  }));
  const litStyle = useAnimatedStyle(() => ({ opacity: active.value, shadowOpacity: 0.6 * active.value }));
  const labelStyle = useAnimatedStyle(() => ({ color: interpolateColor(active.value, [0, 1], [colors.textMuted, "#FFFFFF"]) }));
  return (
    <Animated.View style={[styles.entry, style]}>
      <View style={styles.icon}>
        <SymbolView name={entry.symbol} size={ICON_SIZE} tintColor={colors.textMuted} style={styles.iconLayer} />
        <Animated.View style={[styles.iconLayer, styles.iconLit, litStyle]}>
          <SymbolView name={entry.symbol} size={ICON_SIZE} tintColor={colors.accent} />
        </Animated.View>
      </View>
      <Animated.Text numberOfLines={1} style={[styles.label, labelStyle]}>
        {entry.label}
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  disc: {
    position: "absolute",
    left: 0,
    top: 0,
    width: ACTION_WHEEL_EXTENT * 2,
    height: ACTION_WHEEL_EXTENT * 2,
    borderRadius: ACTION_WHEEL_EXTENT,
    backgroundColor: DISC_COLOR,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  deadZone: {
    position: "absolute",
    width: DEAD_ZONE * 2,
    height: DEAD_ZONE * 2,
    borderRadius: DEAD_ZONE,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  entry: {
    position: "absolute",
    width: ENTRY_WIDTH,
    alignItems: "center",
    gap: 4,
  },
  icon: {
    width: ICON_SIZE,
    height: ICON_SIZE,
  },
  iconLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    width: ICON_SIZE,
    height: ICON_SIZE,
  },
  iconLit: {
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 8,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    textAlign: "center",
  },
});
