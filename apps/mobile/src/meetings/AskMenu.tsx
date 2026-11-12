/**
 * The meeting view's one Ask control: a quiet "Ask <assistant>…" field that opens a sheet of the
 * three asks (MEETING_ASKS). The picked ask's text is posted into the meeting's chat; nothing is
 * answered here.
 */
import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { MEETING_ASKS } from "@relay/protocol";
import { tapHaptic } from "@/lib/haptics";
import { radii, spacing, useColors } from "@/theme";
import { Row } from "@/ui/Row";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";

export function AskMenu({ assistant, onAsk }: { assistant: string; onAsk: (text: string) => void }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Ask ${assistant}`}
        testID="meeting-ask"
        onPress={() => {
          tapHaptic();
          setOpen(true);
        }}
        style={({ pressed }) => [styles.field, { borderColor: colors.hairline, opacity: pressed ? 0.6 : 1 }]}
      >
        <Text variant="label" color="textMuted" style={styles.label} numberOfLines={1}>
          Ask {assistant}…
        </Text>
      </Pressable>
      <Sheet
        visible={open}
        onClose={() => {
          setOpen(false);
        }}
      >
        {MEETING_ASKS.map((ask) => (
          <Row
            key={ask.label}
            title={ask.label}
            testID="meeting-ask-item"
            onPress={() => {
              setOpen(false);
              onAsk(ask.text);
            }}
          />
        ))}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  label: { fontWeight: "400" },
});
