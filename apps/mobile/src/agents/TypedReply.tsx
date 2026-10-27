/**
 * The bottom panel while typing instead of speaking: a multiline field with the send button
 * pinned inside its bottom-right corner. Swiping the keyboard away hands the panel back to voice.
 * The draft survives leaving typing mode (only a send clears it), so dropping the keyboard to read
 * the transcript costs nothing. A draft that starts with "/" opens the session's commands above
 * the field; picking one completes the draft, and sending goes out as typed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { AgentSkill } from "@relay/protocol";
import { IconButton } from "@/ui/IconButton";
import { PasteImageChip } from "@/ui/PasteImageChip";
import { SuggestionList } from "@/ui/SuggestionList";
import { completeSlash, slashMatches } from "@/lib/slash";
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
  /** The session's commands, for the "/" menu; none until the host has answered `agent.options`. */
  skills?: readonly AgentSkill[] | undefined;
  /** Attach the clipboard's image to the next send (iOS fields drop a pasted image). */
  onPasteImage: () => void;
}

export function TypedReply({ draft, onDraft, canSend, onSend, onPasteImage, skills }: TypedReplyProps) {
  const colors = useColors();
  const scheme = useScheme();
  const field = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  // Mounting is entering typing mode: bring the keyboard up with the panel.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const matches = useMemo(() => (skills === undefined ? [] : slashMatches(draft, skills)), [draft, skills]);
  const sendable = canSend && draft.trim() !== "";
  return (
    <View>
      {matches.length > 0 && (
        <View style={styles.menu}>
          <SuggestionList
            suggestions={matches.map((entry) => ({
              key: entry.command,
              title: entry.command,
              hint: entry.hint,
              detail: entry.description,
            }))}
            onPick={(command) => {
              const entry = matches.find((candidate) => candidate.command === command);
              if (entry !== undefined) onDraft(completeSlash(entry));
            }}
          />
        </View>
      )}
      <PasteImageChip active={focused} onPaste={onPasteImage} style={styles.paste} />
      <TextInput
        ref={field}
        style={[styles.field, { backgroundColor: colors.bg, color: colors.text }]}
        value={draft}
        onChangeText={onDraft}
        onFocus={() => { setFocused(true); }}
        onBlur={() => { setFocused(false); }}
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
  /** Floats above the panel, clear of its edge, so the transcript stays put while it is open. */
  menu: { position: "absolute", left: 0, right: 0, bottom: "100%", marginBottom: spacing.md + spacing.sm },
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
  paste: { marginBottom: spacing.sm },
});
