/**
 * The bottom panel while typing instead of speaking: a multiline field with a send button and a
 * mic that hands the panel back to voice. The draft survives leaving typing mode (only a send
 * clears it), so dropping the keyboard to read the transcript costs nothing.
 */
import { useEffect, useRef } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { IconButton } from "@/ui/IconButton";
import { colors, spacing, type } from "@/theme";

/** Room the field may grow to before it scrolls: about five lines. */
const MAX_FIELD_HEIGHT = type.body.lineHeight * 5 + spacing.sm * 2;
const BUTTON_SIZE = 36;

export interface TypedReplyProps {
  draft: string;
  onDraft: (text: string) => void;
  /** False while the dictation pipeline is busy (a send in flight, the sent check); the field stays editable. */
  canSend: boolean;
  onSend: () => void;
  onVoice: () => void;
}

export function TypedReply({ draft, onDraft, canSend, onSend, onVoice }: TypedReplyProps) {
  const field = useRef<TextInput>(null);
  // Mounting is entering typing mode: bring the keyboard up with the panel.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const sendable = canSend && draft.trim() !== "";
  return (
    <View style={styles.row}>
      <IconButton
        symbol="mic"
        size={BUTTON_SIZE}
        tintColor={colors.textMuted}
        backgroundColor={colors.bg}
        onPress={onVoice}
      />
      <TextInput
        ref={field}
        style={styles.field}
        value={draft}
        onChangeText={onDraft}
        multiline
        placeholder="Type a reply"
        placeholderTextColor={colors.textFaint}
        keyboardAppearance="dark"
        selectionColor={colors.accent}
        accessibilityLabel="Reply"
      />
      <IconButton
        symbol="arrow.up"
        size={BUTTON_SIZE}
        tintColor={colors.bg}
        backgroundColor={colors.accent}
        disabled={!sendable}
        onPress={onSend}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  field: {
    flex: 1,
    maxHeight: MAX_FIELD_HEIGHT,
    minHeight: BUTTON_SIZE,
    paddingHorizontal: spacing.md,
    paddingVertical: (BUTTON_SIZE - type.body.lineHeight) / 2,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: colors.bg,
    color: colors.text,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
  },
});
