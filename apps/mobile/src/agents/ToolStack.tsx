/**
 * A run of consecutive tool calls shown as one row: the latest call, with each new one rolling in
 * from above while the previous slides out below. Tapping opens the whole run as a timeline sheet.
 */
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, ReduceMotion, withTiming, type EntryAnimationsValues, type ExitAnimationsValues, type LayoutAnimation } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import type { AgentMessage } from "@relay/protocol";
import { spacing, useColors } from "@/theme";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { ToolRow } from "./ToolRow";

const ROLL = 260;
const timing = { duration: ROLL, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System };

const rollIn = (values: EntryAnimationsValues): LayoutAnimation => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: -values.targetHeight }] },
    animations: { opacity: withTiming(1, timing), transform: [{ translateY: withTiming(0, timing) }] },
  };
};

const rollOut = (values: ExitAnimationsValues): LayoutAnimation => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: { opacity: withTiming(0, timing), transform: [{ translateY: withTiming(values.currentHeight, timing) }] },
  };
};

function Call({ message, flush }: { message: AgentMessage; flush?: boolean }) {
  if (message.tool !== undefined) return <ToolRow name={message.tool.name} summary={message.tool.summary} flush={flush} />;
  return (
    <Text variant="caption" color="textMuted" numberOfLines={1} style={flush ? undefined : { paddingHorizontal: spacing.xl }}>
      {message.text}
    </Text>
  );
}

export function ToolStack({ calls }: { calls: readonly AgentMessage[] }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const latest = calls[calls.length - 1];
  if (latest === undefined) return null;
  return (
    <>
      <Pressable onPress={() => { setOpen(true); }} accessibilityRole="button" accessibilityLabel={`${String(calls.length)} tool calls, show timeline`} style={styles.row}>
        <View style={styles.clip}>
          <Animated.View key={latest.id} entering={rollIn} exiting={rollOut}>
            <Call message={latest} />
          </Animated.View>
        </View>
        {calls.length > 1 && (
          <View style={styles.count}>
            <Text variant="caption" color="textFaint" tabular>
              {String(calls.length)}
            </Text>
            <SymbolView name="chevron.up.chevron.down" size={10} tintColor={colors.textFaint} weight="medium" />
          </View>
        )}
      </Pressable>
      <Sheet visible={open} onClose={() => { setOpen(false); }}>
        <Text variant="title" style={{ marginBottom: spacing.lg }}>
          {calls.length === 1 ? "1 tool call" : `${String(calls.length)} tool calls`}
        </Text>
        {calls.map((call, index) => (
          <View key={call.id} style={styles.step}>
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: index === calls.length - 1 ? colors.accent : colors.textFaint }]} />
              {index < calls.length - 1 && <View style={[styles.line, { backgroundColor: colors.hairline }]} />}
            </View>
            <View style={styles.stepBody}>
              <Call message={call} flush />
            </View>
          </View>
        ))}
      </Sheet>
    </>
  );
}

const DOT = 8;

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingRight: spacing.xl },
  clip: { flex: 1, overflow: "hidden" },
  count: { flexDirection: "row", alignItems: "center", gap: 2 },
  step: { flexDirection: "row", gap: spacing.md },
  rail: { width: DOT, alignItems: "center", paddingTop: 5 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  line: { flex: 1, width: 1.5, marginTop: spacing.xs },
  stepBody: { flex: 1, paddingBottom: spacing.lg },
});
