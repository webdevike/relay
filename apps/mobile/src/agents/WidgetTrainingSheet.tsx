/**
 * The 🎯 "Train on this" sheet (protocol "Reply widgets"): one question about the assistant reply
 * Isaac marked, asked on an `OverlaySheet` (a modal sheet does not present on the assistant thread).
 * "Keep it like this" first, then what it should have been as chips. One tap answers (`onPick`) and
 * the caller closes; a dismissal sends nothing.
 */
import { StyleSheet, View } from "react-native";
import { WIDGET_LABEL_TEXT, WIDGET_LABELS, type WidgetLabel } from "@relay/protocol";
import { Button } from "@/ui/Button";
import { Chip } from "@/ui/Chip";
import { IconButton } from "@/ui/IconButton";
import { OverlaySheet } from "@/ui/OverlaySheet";
import { Text } from "@/ui/Text";
import { spacing, useColors } from "@/theme";

/** The labels that say what the reply should have been, in the sheet's order. */
const INSTEAD = WIDGET_LABELS.filter((label) => label !== "keep");

export interface WidgetTrainingSheetProps {
  open: boolean;
  onPick: (label: WidgetLabel) => void;
  onClose: () => void;
}

export function WidgetTrainingSheet({ open, onPick, onClose }: WidgetTrainingSheetProps) {
  const colors = useColors();
  return (
    <OverlaySheet
      open={open}
      onClose={onClose}
      header={
        <View style={[styles.head, { borderBottomColor: colors.hairline }]}>
          <Text variant="title" style={styles.title} accessibilityRole="header">
            Train on this
          </Text>
          <IconButton symbol="xmark" size={34} accessibilityLabel="Close without a label" onPress={onClose} />
        </View>
      }
    >
      <View style={styles.body}>
        <Button
          label={WIDGET_LABEL_TEXT.keep}
          height={48}
          testID="widget-label-keep"
          onPress={() => {
            onPick("keep");
          }}
        />
        <Text variant="label" color="textMuted">
          Should&apos;ve been:
        </Text>
        <View style={styles.chips}>
          {INSTEAD.map((label) => (
            <Chip
              key={label}
              label={WIDGET_LABEL_TEXT[label]}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
              onPress={() => {
                onPick(label);
              }}
            />
          ))}
        </View>
      </View>
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.xl, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1 },
  body: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
