import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { MAX_ASK_ANSWER, type OpenAsk } from "@relay/protocol";
import { Chip } from "@/ui/Chip";
import { IconButton } from "@/ui/IconButton";
import { OverlaySheet } from "@/ui/OverlaySheet";
import { ReplyChips } from "@/ui/ReplyChips";
import { SheetTextInput } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { defaultNote } from "@/lib/openAsks";
import { relativeTime } from "@/lib/format";
import { radii, spacing, useColors } from "@/theme";

export interface OpenAsksSheetProps {
  open: boolean;
  /** The open questions, newest first (`visibleAsks`). */
  asks: readonly OpenAsk[];
  /** The assistant's name: who asks, unless a session asked through the thread (`from`). */
  assistant: string;
  /** False while offline: answers and dismissals could not reach the host, so only Show in chat stays. */
  connected: boolean;
  onAnswer: (ask: OpenAsk, answer: string) => void;
  onDismiss: (ask: OpenAsk) => void;
  onShow: (ask: OpenAsk) => void;
  onClose: () => void;
}

/**
 * Every question still waiting on Isaac in one assistant thread, answered right here: flat rows on
 * hairline dividers, each who asks and when, the question, its answers as chips (a session ask's
 * default drawn selected, with what it goes with unless he says otherwise), and "Other" for a typed
 * answer (the field shows at once for a question with no answers). Show in chat and Dismiss sit
 * quietly on the row's first line.
 */
export function OpenAsksSheet({ open, asks, assistant, connected, onAnswer, onDismiss, onShow, onClose }: OpenAsksSheetProps) {
  const colors = useColors();
  return (
    <OverlaySheet
      open={open}
      onClose={onClose}
      header={
        <View style={[styles.head, { borderBottomColor: colors.hairline }]}>
          <Text variant="title" style={styles.title}>
            Open questions
          </Text>
          <IconButton symbol="xmark" size={34} accessibilityLabel="Close open questions" onPress={onClose} />
        </View>
      }
    >
      {asks.length === 0 ? (
        <Text color="textMuted" style={styles.empty}>
          Nothing is waiting on you.
        </Text>
      ) : (
        asks.map((ask, index) => (
          <AskRow
            key={ask.id}
            ask={ask}
            source={ask.from ?? assistant}
            first={index === 0}
            connected={connected}
            onAnswer={(answer) => {
              onAnswer(ask, answer);
            }}
            onDismiss={() => {
              onDismiss(ask);
            }}
            onShow={() => {
              onShow(ask);
            }}
          />
        ))
      )}
    </OverlaySheet>
  );
}

function AskRow({ ask, source, first, connected, onAnswer, onDismiss, onShow }: { ask: OpenAsk; source: string; first: boolean; connected: boolean; onAnswer: (answer: string) => void; onDismiss: () => void; onShow: () => void }) {
  const colors = useColors();
  const note = defaultNote(ask);
  const [typing, setTyping] = useState(ask.replies.length === 0);
  const [draft, setDraft] = useState("");
  const typed = draft.trim();
  const sendTyped = (): void => {
    if (typed === "") return;
    onAnswer(typed.slice(0, MAX_ASK_ANSWER));
  };
  return (
    <View style={[styles.row, !first && { borderTopColor: colors.hairline, borderTopWidth: StyleSheet.hairlineWidth }]} testID="open-ask-row">
      <View style={styles.meta}>
        <Text variant="label" color="textMuted" numberOfLines={1} style={styles.source}>
          {`${source} · ${relativeTime(ask.at)}`}
        </Text>
        <TextAction label="Show in chat" onPress={onShow} />
        {connected && <TextAction label="Dismiss" onPress={onDismiss} />}
      </View>
      <Text style={styles.question}>{ask.question}</Text>
      {note !== null && (
        <Text variant="caption" color="textMuted">
          {note}
        </Text>
      )}
      {connected && (
        <View style={styles.answers}>
          {ask.replies.length > 0 && (
            <ReplyChips
              replies={ask.replies}
              selected={ask.default}
              onPick={onAnswer}
              trailing={
                typing ? null : (
                  <Chip
                    label="Other"
                    accessibilityLabel="Type another answer"
                    onPress={() => {
                      setTyping(true);
                    }}
                  />
                )
              }
            />
          )}
          {typing && (
            <View style={styles.field}>
              <SheetTextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Your answer"
                placeholderTextColor={colors.textFaint}
                autoFocus={ask.replies.length > 0}
                returnKeyType="send"
                onSubmitEditing={sendTyped}
                maxLength={MAX_ASK_ANSWER}
                style={[styles.input, { borderColor: colors.hairline, color: colors.text }]}
                accessibilityLabel={`Answer: ${ask.question}`}
              />
              <IconButton
                symbol="arrow.up"
                size={34}
                glyphSize={16}
                disabled={typed === ""}
                backgroundColor={typed === "" ? colors.hairline : colors.accent}
                tintColor={typed === "" ? colors.textMuted : "#FFFFFF"}
                accessibilityLabel="Send answer"
                onPress={sendTyped}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function TextAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={10} onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      <Text variant="label" color="textMuted">
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.xl, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1 },
  empty: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl, textAlign: "center" },
  row: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, gap: spacing.xs },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  source: { flex: 1 },
  question: { fontSize: 16, lineHeight: 22 },
  answers: { marginTop: spacing.sm, gap: spacing.sm },
  field: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  input: { flex: 1, height: 36, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 15 },
  pressed: { opacity: 0.6 },
});
