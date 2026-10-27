/**
 * A run of consecutive tool calls shown as one line: the latest call, with each new one rolling in
 * from above while the previous slides out below. Tapping opens the whole run as a timeline sheet.
 */
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  type LayoutAnimation,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import type { AgentMessage } from "@relay/protocol";
import { spacing, useColors } from "@/theme";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { ToolRow, toolGlyph, toolLabel } from "./ToolRow";

const ROLL = 260;
const GLYPH = 11;
const timing = {
  duration: ROLL,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};

const rollIn = (values: EntryAnimationsValues): LayoutAnimation => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: -values.targetHeight }] },
    animations: {
      opacity: withTiming(1, timing),
      transform: [{ translateY: withTiming(0, timing) }],
    },
  };
};

const rollOut = (values: ExitAnimationsValues): LayoutAnimation => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: {
      opacity: withTiming(0, timing),
      transform: [{ translateY: withTiming(values.currentHeight, timing) }],
    },
  };
};

/** One call as a single line: glyph, then what it did (or the tool's name when it has no summary). */
function CallLine({ message }: { message: AgentMessage }) {
  const colors = useColors();
  const text =
    message.tool === undefined
      ? message.text
      : message.tool.summary || toolLabel(message.tool.name);
  return (
    <View style={styles.line}>
      <SymbolView
        name={toolGlyph(message.tool?.name)}
        size={GLYPH}
        tintColor={colors.textFaint}
        weight="medium"
      />
      <Text variant="caption" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

export function ToolStack({
  calls,
  onOpen,
}: {
  calls: readonly AgentMessage[];
  onOpen: () => void;
}) {
  const colors = useColors();
  // Same gesture system as the chat card's own handlers, so they never swallow the tap (a plain Pressable lost it).
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .hitSlop(8)
        .onEnd((_event, success) => {
          if (success) onOpen();
        }),
    [onOpen],
  );
  const latest = calls[calls.length - 1];
  if (latest === undefined) return null;
  return (
    <GestureDetector gesture={tap}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${String(calls.length)} tool calls, show timeline`}
        style={styles.row}
      >
        <View style={styles.clip}>
          <Animated.View key={latest.id} entering={rollIn} exiting={rollOut}>
            <CallLine message={latest} />
          </Animated.View>
        </View>
        {calls.length > 1 && (
          <Text variant="caption" color="textFaint" tabular>
            {String(calls.length)}
          </Text>
        )}
        <SymbolView name="chevron.up" size={10} tintColor={colors.textFaint} weight="medium" />
      </View>
    </GestureDetector>
  );
}

/** Every call in a run, oldest first, on a timeline rail; the newest dot is the accent. */
export function ToolTimelineSheet({
  calls: list,
  onClose,
}: {
  calls: readonly AgentMessage[];
  onClose: () => void;
}) {
  const colors = useColors();
  return (
    <Sheet visible onClose={onClose}>
      <Text variant="title" style={{ marginBottom: spacing.lg }}>
        {list.length === 1 ? "1 tool call" : `${String(list.length)} tool calls`}
      </Text>
      {list.map((call, index) => (
        <View key={call.id} style={styles.step}>
          <View style={styles.rail}>
            <View
              style={[
                styles.dot,
                { backgroundColor: index === list.length - 1 ? colors.accent : colors.textFaint },
              ]}
            />
            {index < list.length - 1 && (
              <View style={[styles.railLine, { backgroundColor: colors.hairline }]} />
            )}
          </View>
          <View style={styles.stepBody}>
            {call.tool !== undefined ? (
              <ToolRow name={call.tool.name} summary={call.tool.summary} flush />
            ) : (
              <Text variant="caption" color="textMuted">
                {call.text}
              </Text>
            )}
          </View>
        </View>
      ))}
    </Sheet>
  );
}

const DOT = 8;

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.xl,
  },
  clip: { flex: 1, overflow: "hidden" },
  line: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  step: { flexDirection: "row", gap: spacing.md },
  rail: { width: DOT, alignItems: "center", paddingTop: 5 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  railLine: { flex: 1, width: 1.5, marginTop: spacing.xs },
  stepBody: { flex: 1, paddingBottom: spacing.lg },
});
