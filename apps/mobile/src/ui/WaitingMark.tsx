import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { Text } from "./Text";
import { useColors, withAlpha } from "@/theme";

const EDGE_ALPHA = 0.55;
const TAG_HEIGHT = 18;
/** How far the tag rides above the edge, and how far in from the right corner it sits. */
const TAG_RISE = TAG_HEIGHT / 2;
const TAG_INSET = 14;

export interface WaitingMarkProps {
  /** Corner radius of the bubble or card it marks. */
  radius: number;
  /** The page colour behind the bubble, the tag's fill. */
  page: string;
}

/**
 * The quiet "this is waiting on you" mark on a chat bubble or card that holds an open ask: a thin
 * accent edge and a small "Waiting on you" tag riding its top-right corner, drawn over the bubble
 * without taking any layout room (render it as a child of the bubble's view). Never receives touches.
 */
export function WaitingMark({ radius, page }: WaitingMarkProps) {
  const colors = useColors();
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeIn.duration(220).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(160).reduceMotion(ReduceMotion.System)}
      style={StyleSheet.absoluteFill}
    >
      <View style={[styles.edge, { borderRadius: radius, borderColor: withAlpha(colors.accent, EDGE_ALPHA) }]} />
      <View style={[styles.tag, { backgroundColor: page, borderColor: withAlpha(colors.accent, EDGE_ALPHA) }]} accessible accessibilityLabel="Waiting on you">
        <Text variant="caption" color="accent" style={styles.tagText}>
          Waiting on you
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  edge: { ...StyleSheet.absoluteFillObject, borderWidth: 1 },
  tag: {
    position: "absolute",
    top: -TAG_RISE,
    right: TAG_INSET,
    height: TAG_HEIGHT,
    paddingHorizontal: 8,
    justifyContent: "center",
    borderRadius: TAG_HEIGHT / 2,
    borderWidth: 1,
  },
  tagText: { fontSize: 11, lineHeight: 14, fontWeight: "500" },
});
