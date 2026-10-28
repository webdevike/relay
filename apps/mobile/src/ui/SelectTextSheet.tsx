/**
 * "Select Text" from a bubble's menu: a native page sheet (RN `Modal`) with the bubble's whole
 * text in a read-only multiline field, so Isaac can drag the iOS selection handles over any span
 * and copy, look up or share just that (a chat bubble only offers all of it).
 */
import { Modal, StyleSheet, TextInput, View } from "react-native";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { spacing, useColors, useScheme } from "@/theme";

export interface SelectTextSheetProps {
  /** The text to select from; null keeps the sheet closed. */
  text: string | null;
  onClose: () => void;
}

export function SelectTextSheet({ text, onClose }: SelectTextSheetProps) {
  const colors = useColors();
  const scheme = useScheme();
  return (
    <Modal visible={text !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.body, { backgroundColor: colors.surface }]}>
        <View style={styles.head}>
          <Text variant="title" style={styles.flex}>
            Select Text
          </Text>
          <Button label="Done" variant="ghost" onPress={onClose} />
        </View>
        {text !== null && (
          <TextInput
            value={text}
            editable={false}
            multiline
            scrollEnabled
            contextMenuHidden={false}
            selectionColor={colors.accent}
            keyboardAppearance={scheme}
            accessibilityLabel="Message text"
            style={[styles.field, { color: colors.text }]}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingTop: spacing.xl },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
  flex: { flex: 1 },
  field: { flex: 1, fontSize: 17, lineHeight: 24, paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl, textAlignVertical: "top" },
});
