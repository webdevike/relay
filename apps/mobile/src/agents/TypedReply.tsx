/**
 * The bottom panel while typing instead of speaking: a multiline field over a toolbar holding the
 * session settings (model, thinking) on the left and send on the right, the same shape as the
 * EvaOS composer. Swiping the keyboard away hands the panel back to voice. The draft survives
 * leaving typing mode (only a send clears it), so dropping the keyboard to read the transcript
 * costs nothing.
 */
import { useEffect, useRef } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { spacing, type, useColors, useScheme } from "@/theme";

/** Room the field may grow to before it scrolls: about five lines. */
const MAX_FIELD_HEIGHT = type.body.lineHeight * 5 + spacing.md * 2;
/** Two lines tall when empty, so the field reads as the place to write. */
const MIN_FIELD_HEIGHT = type.body.lineHeight * 2 + spacing.md * 2;
const BUTTON_SIZE = 44;

export interface TypedReplyProps {
  draft: string;
  onDraft: (text: string) => void;
  /** False while the dictation pipeline is busy (a send in flight, the sent check); the field stays editable. */
  canSend: boolean;
  onSend: () => void;
  /** Opens the session's settings sheet (model, thinking); omitted when there is no session to configure. */
  onSettings?: () => void;
  /** Display name of the session's model, shown beside the settings button. */
  model?: string;
  /** Corner radius of the field, concentric with the panel around it. */
  fieldRadius: number;
}

export function TypedReply({ draft, onDraft, canSend, onSend, onSettings, model, fieldRadius }: TypedReplyProps) {
  const colors = useColors();
  const scheme = useScheme();
  const field = useRef<TextInput>(null);
  // Mounting is entering typing mode: bring the keyboard up with the panel.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const sendable = canSend && draft.trim() !== "";
  return (
    <View style={styles.stack}>
      <TextInput
        ref={field}
        style={[styles.field, { backgroundColor: colors.bg, color: colors.text, borderRadius: fieldRadius }]}
        value={draft}
        onChangeText={onDraft}
        multiline
        placeholder="Type a reply"
        placeholderTextColor={colors.textFaint}
        keyboardAppearance={scheme}
        selectionColor={colors.accent}
        accessibilityLabel="Reply"
      />
      <View style={styles.toolbar}>
        <IconButton
          symbol="slider.horizontal.3"
          size={BUTTON_SIZE}
          tintColor={colors.textMuted}
          backgroundColor={colors.bg}
          disabled={onSettings === undefined}
          onPress={() => onSettings?.()}
        />
        <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.model}>
          {model ?? ""}
        </Text>
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
  stack: { gap: spacing.sm },
  field: {
    minHeight: MIN_FIELD_HEIGHT,
    maxHeight: MAX_FIELD_HEIGHT,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
    textAlignVertical: "top",
  },
  toolbar: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  model: { flex: 1 },
});
