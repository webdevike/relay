/**
 * The long-press handoff sheet for a Catch Up card: pick the assistant (the card's own lane is
 * preselected), add an optional note, Send. A native iOS page sheet (RN `Modal`), composed from
 * `OptionRow`, `TextField` and `Button`. (The gorhom `Sheet` presented and dismissed itself at once
 * over the deck's gesture handlers.)
 */
import { useEffect, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import type { AssistantPortrait, AssistantStatus, CatchUpCard } from "@relay/protocol";
import { Button } from "@/ui/Button";
import { OptionRow } from "@/ui/OptionRow";
import { BreathingPortrait } from "@/ui/BreathingPortrait";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { defaultAssistant } from "@/lib/catchup";
import { portraitOf } from "@/lib/portrait";
import { spacing, useColors } from "@/theme";

const PORTRAIT = 32;

export interface HandoffTarget {
  id: string;
  title: string;
  scope?: string | undefined;
  /** The registry's portrait seed and designed portrait, when the host listed them. */
  avatar?: string | undefined;
  portrait?: AssistantPortrait | undefined;
  /** Where its thread stands (the portrait's VoiceOver label says when it works). */
  status?: AssistantStatus | undefined;
}

export interface HandoffSheetProps {
  /** The card being handed off; null hides the sheet. */
  card: CatchUpCard | null;
  targets: readonly HandoffTarget[];
  onClose: () => void;
  onSend: (card: CatchUpCard, agent: string, note: string) => void;
}

export function HandoffSheet({ card, targets, onClose, onSend }: HandoffSheetProps) {
  const colors = useColors();
  const [agent, setAgent] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const cardId = card?.id;
  // Each card opens on its own lane with an empty note.
  useEffect(() => {
    setAgent(null);
    setNote("");
  }, [cardId]);
  const chosen = agent ?? (card === null ? null : defaultAssistant(card));
  return (
    <Modal visible={card !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {card !== null && (
        <View style={[styles.body, { backgroundColor: colors.surface }]}>
          <View style={styles.head}>
            <View style={styles.flex}>
              <Text variant="title">Hand off</Text>
              <Text variant="caption" color="textMuted" numberOfLines={2}>
                {card.title}
              </Text>
            </View>
            <Button label="Cancel" variant="ghost" onPress={onClose} />
          </View>
          <View style={styles.options}>
            {targets.map((target) => (
              <OptionRow
                key={target.id}
                label={target.title}
                description={target.scope}
                badge={target.id === defaultAssistant(card) ? "Usual" : undefined}
                leading={<BreathingPortrait name={target.title} portrait={portraitOf(target)} size={PORTRAIT} working={target.status === "working"} />}
                selected={chosen === target.id}
                onPress={() => {
                  setAgent(target.id);
                }}
              />
            ))}
          </View>
          <TextField value={note} onChangeText={setNote} placeholder="Add a note (optional)" multiline />
          <Button
            label={`Send to ${targets.find((target) => target.id === chosen)?.title ?? "assistant"}`}
            height={48}
            disabled={chosen === null}
            onPress={() => {
              if (chosen !== null) onSend(card, chosen, note);
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
  options: { gap: spacing.sm },
  flex: { flex: 1, gap: spacing.xs },
});
