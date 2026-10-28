/**
 * The "more" reactions: a native page sheet (RN `Modal`, as `HandoffSheet`; a gorhom `Sheet` does
 * not present on the Eva screen) with a grid of emoji by section (`lib/reactions.ts`
 * `MORE_REACTIONS`), the current reaction highlighted. Picking one reports it; the caller closes.
 */
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { MORE_REACTIONS } from "@/lib/reactions";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { spacing, useColors, useScheme, withAlpha } from "@/theme";

/** Seven columns across the sheet; each cell is a square seventh of its width. */
const CELL_WIDTH = "14.285%";

export interface EmojiPickerSheetProps {
  visible: boolean;
  /** The bubble's reaction, or null. */
  current: string | null;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPickerSheet({ visible, current, onPick, onClose }: EmojiPickerSheetProps) {
  const colors = useColors();
  const highlight = withAlpha(colors.accent, useScheme() === "dark" ? 0.38 : 0.22);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.body, { backgroundColor: colors.surface }]}>
        <View style={styles.head}>
          <Text variant="title" style={styles.flex}>
            React
          </Text>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.sections}>
          {MORE_REACTIONS.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text variant="label" color="textMuted" accessibilityRole="header">
                {section.title}
              </Text>
              <View style={styles.grid}>
                {section.emoji.map((emoji) => (
                  <Pressable
                    key={emoji}
                    accessibilityRole="button"
                    accessibilityLabel={emoji}
                    accessibilityState={{ selected: emoji === current }}
                    onPress={() => {
                      onPick(emoji);
                    }}
                    style={({ pressed }) => [styles.cell, (emoji === current || pressed) && { backgroundColor: emoji === current ? highlight : colors.hairline }]}
                  >
                    <Text style={styles.emoji}>{emoji}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingTop: spacing.xl },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
  flex: { flex: 1 },
  sections: { gap: spacing.xl, paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  section: { gap: spacing.sm },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: CELL_WIDTH, aspectRatio: 1, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  emoji: { fontSize: 30, lineHeight: 36 },
});
