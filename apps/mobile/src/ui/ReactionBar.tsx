/**
 * The tapback bar that floats above a long-pressed chat bubble: the protocol's six quick picks and
 * a "more" button, on a glass capsule. The bubble's current reaction sits in a tinted disc (tapping
 * it again takes it back). An emoji from "more" that is not a quick pick shows in place of the
 * plus, highlighted, so the current reaction is always visible. It pops in from its anchored edge;
 * with Reduce Motion it only fades.
 */
import { Pressable, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { SymbolView } from "expo-symbols";
import Animated, { FadeIn, ZoomIn } from "react-native-reanimated";
import { QUICK_REACTIONS } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { useColors, useScheme, withAlpha } from "@/theme";

const BUTTON = 40;
const PAD = 5;
const GAP = 2;

/** The bar's size, for placing it before it is drawn. */
export const REACTION_BAR_SIZE = {
  width: PAD * 2 + BUTTON * (QUICK_REACTIONS.length + 1) + GAP * QUICK_REACTIONS.length,
  height: PAD * 2 + BUTTON,
} as const;

/** VoiceOver names of the quick picks, as iMessage reads its tapbacks. */
const QUICK_LABEL: Record<(typeof QUICK_REACTIONS)[number], string> = {
  "❤️": "Heart",
  "👍": "Thumbs up",
  "👎": "Thumbs down",
  "😂": "Ha ha",
  "‼️": "Exclamation marks",
  "❓": "Question mark",
};

export interface ReactionBarProps {
  /** The bubble's reaction, or null. */
  current: string | null;
  onPick: (emoji: string) => void;
  /** Open the full emoji picker. */
  onMore: () => void;
  /** Which end of the bar grows from the bubble (the bubble's side). */
  anchor: "left" | "right";
  reducedMotion: boolean;
}

export function ReactionBar({ current, onPick, onMore, anchor, reducedMotion }: ReactionBarProps) {
  const colors = useColors();
  const scheme = useScheme();
  const highlight = withAlpha(colors.accent, scheme === "dark" ? 0.38 : 0.22);
  const custom = current !== null && !(QUICK_REACTIONS as readonly string[]).includes(current) ? current : null;
  const entering = reducedMotion ? FadeIn.duration(140) : ZoomIn.springify().damping(16).stiffness(260).mass(0.7);
  return (
    <Animated.View
      entering={entering}
      style={[styles.bar, { borderColor: colors.hairline, transformOrigin: `${anchor} bottom` }]}
      accessibilityRole="toolbar"
      accessibilityLabel="Reactions"
    >
      <BlurView intensity={90} tint={scheme === "dark" ? "systemThickMaterialDark" : "systemThickMaterialLight"} style={StyleSheet.absoluteFill} />
      <View style={styles.row}>
        {QUICK_REACTIONS.map((emoji) => {
          const selected = emoji === current;
          return (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={QUICK_LABEL[emoji]}
              accessibilityState={{ selected }}
              {...(selected ? { accessibilityHint: "Removes your reaction" } : {})}
              onPress={() => {
                onPick(emoji);
              }}
              style={({ pressed }) => [styles.button, (selected || pressed) && { backgroundColor: selected ? highlight : colors.hairline }]}
            >
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={custom === null ? "More reactions" : `Reacted ${custom}. More reactions`}
          accessibilityState={{ selected: custom !== null }}
          onPress={onMore}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: custom !== null ? highlight : pressed ? colors.textFaint : colors.hairline },
          ]}
        >
          {custom === null ? <SymbolView name="plus" size={18} weight="semibold" tintColor={colors.textMuted} /> : <Text style={styles.emoji}>{custom}</Text>}
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    width: REACTION_BAR_SIZE.width,
    height: REACTION_BAR_SIZE.height,
    borderRadius: REACTION_BAR_SIZE.height / 2,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  row: { flexDirection: "row", alignItems: "center", gap: GAP, padding: PAD },
  button: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: "center", justifyContent: "center" },
  emoji: { fontSize: 25, lineHeight: 30 },
});
