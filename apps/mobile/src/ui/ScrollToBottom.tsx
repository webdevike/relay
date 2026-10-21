import { Pressable, StyleSheet } from "react-native";
import { SymbolView } from "expo-symbols";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { spacing, useColors } from "@/theme";

/** Identical navigation affordance in assistant, agent and subagent transcripts. */
export function ScrollToBottom({ visible, onPress, bottom = spacing.sm }: { visible: boolean; onPress: () => void; bottom?: number }) {
  const colors = useColors();
  if (!visible) return null;
  return (
    <Animated.View entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(160).reduceMotion(ReduceMotion.System)} style={[styles.position, { bottom }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Scroll to bottom" onPress={onPress}
        style={({ pressed }) => [styles.button, { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline, opacity: pressed ? 0.8 : 1 }]}>
        <SymbolView name="arrow.down" size={16} tintColor={colors.text} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  position: { position: "absolute", right: spacing.lg },
  button: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 22 },
});
