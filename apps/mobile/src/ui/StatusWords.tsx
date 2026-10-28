import { StyleSheet, View, type StyleProp, type TextStyle } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { motion } from "@/theme";
import { Text } from "./Text";

/**
 * An assistant's status words in a list ("is researching", "needs you"), muted on one line: they
 * crossfade as they change, and the line keeps its height with none, so nothing below moves.
 */
export function StatusWords({ words, style }: { words: string | null; style?: StyleProp<TextStyle> }) {
  return (
    <View style={styles.line}>
      {/* Sizes the line; the shown words crossfade over it. */}
      <Text variant="caption" numberOfLines={1} style={[style, styles.hidden]}>
        {words ?? " "}
      </Text>
      {words !== null && (
        <Animated.View
          key={words}
          entering={FadeIn.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
          style={styles.shown}
        >
          <Text variant="caption" color="textMuted" numberOfLines={1} style={style}>
            {words}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexShrink: 1, minWidth: 0 },
  hidden: { opacity: 0 },
  shown: { ...StyleSheet.absoluteFillObject },
});
