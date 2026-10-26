/**
 * The note sheet for a Catch Up card: Isaac says why it does or doesn't need him, with a chip
 * (Needs me, Not actionable, Just FYI), free text, or both, and saves it for Nova, who turns notes into
 * the rules and taste guide the feed is built from. The card stays in the deck. A native iOS page sheet
 * (RN `Modal`) like `HandoffSheet`.
 */
import { useEffect, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { CATCHUP_SIGNALS, type CatchUpCard, type CatchUpSignal } from "@relay/protocol";
import { Button } from "@/ui/Button";
import { Chip } from "@/ui/Chip";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { spacing, useColors } from "@/theme";

const SIGNAL_LABEL: Record<CatchUpSignal, string> = {
  "needs-me": "Needs me",
  "not-actionable": "Not actionable",
  fyi: "Just FYI",
};

export interface NoteSheetProps {
  /** The card the note is about; null hides the sheet. */
  card: CatchUpCard | null;
  onClose: () => void;
  onSave: (card: CatchUpCard, signal: CatchUpSignal | undefined, text: string) => void;
}

export function NoteSheet({ card, onClose, onSave }: NoteSheetProps) {
  const colors = useColors();
  const [signal, setSignal] = useState<CatchUpSignal | undefined>(undefined);
  const [text, setText] = useState("");
  const cardId = card?.id;
  // Each card opens blank.
  useEffect(() => {
    setSignal(undefined);
    setText("");
  }, [cardId]);
  return (
    <Modal visible={card !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {card !== null && (
        <View style={[styles.body, { backgroundColor: colors.surface }]}>
          <View style={styles.head}>
            <View style={styles.flex}>
              <Text variant="title">Why does or doesn't this need you?</Text>
              <Text variant="caption" color="textMuted" numberOfLines={2}>
                {card.title}
              </Text>
            </View>
            <Button label="Cancel" variant="ghost" onPress={onClose} />
          </View>
          <View style={styles.chips}>
            {CATCHUP_SIGNALS.map((option) => (
              <Chip
                key={option}
                label={SIGNAL_LABEL[option]}
                selected={signal === option}
                onPress={() => {
                  setSignal(signal === option ? undefined : option);
                }}
              />
            ))}
          </View>
          <TextField value={text} onChangeText={setText} placeholder="e.g. Todd's release asks always need me" multiline />
          <Text variant="caption" color="textFaint">
            Nova reads every note and teaches Catch Up what is worth a card.
          </Text>
          <Button
            label="Save note"
            height={48}
            disabled={signal === undefined && text.trim() === ""}
            onPress={() => {
              onSave(card, signal, text);
            }}
          />
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: spacing.lg, padding: spacing.xl },
  head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  flex: { flex: 1, gap: spacing.xs },
});
