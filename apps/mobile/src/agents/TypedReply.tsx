/**
 * The bottom panel while typing instead of speaking: a multiline field with the send button
 * pinned inside its bottom-right corner. Swiping the keyboard away hands the panel back to voice.
 * The draft survives leaving typing mode (only a send clears it), so dropping the keyboard to read
 * the transcript costs nothing.
 */
import { useEffect, useRef } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { IconButton } from "@/ui/IconButton";
import { spacing, type, useColors, useScheme } from "@/theme";

const BUTTON_SIZE = 44;
/** Gap between the send button and the field's edge. */
const INSET = 4;
const FIELD_MIN_HEIGHT = BUTTON_SIZE + INSET * 2;
/** Room the field may grow to before it scrolls: about five lines. */
const MAX_FIELD_HEIGHT = type.body.lineHeight * 5 + spacing.md * 2;

export interface TypedReplyProps {
  draft: string;
  onDraft: (text: string) => void;
  /** False while the dictation pipeline is busy (a send in flight, the sent check); the field stays editable. */
  canSend: boolean;
  onSend: () => void;
}

export function TypedReply({ draft, onDraft, canSend, onSend }: TypedReplyProps) {
  const colors = useColors();
  const scheme = useScheme();
  const field = useRef<TextInput>(null);
  // Mounting is entering typing mode: bring the keyboard up with the panel.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const sendable = canSend && draft.trim() !== "";
  return (
    <View>
      <TextInput
        ref={field}
        style={[styles.field, { backgroundColor: colors.bg, color: colors.text }]}
        value={draft}
        onChangeText={onDraft}
        multiline
        placeholder="Type a reply"
        placeholderTextColor={colors.textFaint}
        keyboardAppearance={scheme}
        selectionColor={colors.accent}
        accessibilityLabel="Reply"
      />
      <View style={styles.send}>
        <IconButton
          symbol="arrow.up"
          size={BUTTON_SIZE}
          tintColor={colors.bg}
          backgroundColor={colors.accent}
          disabled={!sendable}
          onPress={onSend}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    minHeight: FIELD_MIN_HEIGHT,
    maxHeight: MAX_FIELD_HEIGHT,
    paddingLeft: spacing.lg,
    // Text never runs under the button.
    paddingRight: BUTTON_SIZE + INSET + spacing.sm,
    paddingVertical: (FIELD_MIN_HEIGHT - type.body.lineHeight) / 2,
    borderRadius: FIELD_MIN_HEIGHT / 2,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
  },
  /** Pinned to the bottom-right corner, so it stays put as the draft grows. */
  send: { position: "absolute", right: INSET, bottom: INSET },
});
