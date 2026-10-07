/**
 * The bottom panel while typing instead of speaking: a multiline field with the send button
 * carved out of its bottom-right corner, the same cutout the inbox mic makes in the cards it
 * straddles. Swiping the keyboard away hands the panel back to voice. The draft survives leaving
 * typing mode (only a send clears it), so dropping the keyboard to read the transcript costs
 * nothing.
 */
import { useEffect, useRef } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { IconButton } from "@/ui/IconButton";
import { Cutout, CUTOUT_GAP } from "@/ui/Cutout";
import { spacing, type, useColors, useScheme } from "@/theme";

const BUTTON_SIZE = 36;
/** How far the cutout ring hangs past the field's right and bottom edges, into the panel padding. */
const OVERHANG = 6;
/** The ring's footprint inside the field, which the text must stay clear of. */
const RING_INSIDE = BUTTON_SIZE + CUTOUT_GAP * 2 - OVERHANG;
const FIELD_MIN_HEIGHT = type.body.lineHeight + spacing.md * 2;
/** Room the field may grow to before it scrolls: about five lines. */
const MAX_FIELD_HEIGHT = type.body.lineHeight * 5 + spacing.md * 2;

export interface TypedReplyProps {
  draft: string;
  onDraft: (text: string) => void;
  /** False while the dictation pipeline is busy (a send in flight, the sent check); the field stays editable. */
  canSend: boolean;
  onSend: () => void;
  /** The panel the field sits on: the cutout ring is painted in it so the button reads as carved out. */
  surfaceColor: string;
}

export function TypedReply({ draft, onDraft, canSend, onSend, surfaceColor }: TypedReplyProps) {
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
      <Cutout size={BUTTON_SIZE} color={surfaceColor} style={styles.send}>
        <IconButton
          symbol="arrow.up"
          size={BUTTON_SIZE}
          tintColor={colors.bg}
          backgroundColor={colors.accent}
          disabled={!sendable}
          feedback="press"
          // The whole ring is the target: 44pt to the finger, 36pt to the eye.
          hitSlop={CUTOUT_GAP}
          onPress={onSend}
        />
      </Cutout>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    minHeight: FIELD_MIN_HEIGHT,
    maxHeight: MAX_FIELD_HEIGHT,
    paddingLeft: spacing.lg,
    // Text never runs under the ring.
    paddingRight: RING_INSIDE + spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: FIELD_MIN_HEIGHT / 2,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
  },
  /** Pinned to the bottom-right corner, so it stays put as the draft grows. */
  send: { right: -OVERHANG, bottom: -OVERHANG },
});
