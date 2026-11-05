import { useEffect, useReducer, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import type { AgentAsk, AgentAskQuestion } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { OptionRow } from "@/ui/OptionRow";
import { radii, spacing, useColors } from "@/theme";
import { advancesOnPick, answersOf, firstUnanswered, initialDraft, isAnswered, reduceAsk, type AskAction, type AskAnswer, type AskDraft } from "@/agents/askState";

export type { AskAnswer };


export interface AskCardProps {
  ask: AgentAsk;
  onSubmit: (results: AskAnswer[]) => void;
  /** Dismiss the ask without answering (omp's dialog resolves as cancelled). */
  onCancel: () => void;
}


function Question({
  question,
  selected,
  custom,
  onToggle,
  onCustom,
}: {
  question: AgentAskQuestion;
  selected: string[];
  custom: string;
  onToggle: (label: string) => void;
  onCustom: (text: string) => void;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: spacing.sm }}>
      {question.header !== undefined && question.header.length > 0 && (
        <Text variant="caption" color="textFaint">
          {question.header}
        </Text>
      )}
      <Text variant="label" color="text">
        {question.question}
      </Text>
      <View style={{ gap: spacing.sm }}>
        {question.options.map((option, index) => (
          <OptionRow
            key={option.label}
            label={option.label}
            description={option.description}
            selected={selected.includes(option.label)}
            badge={question.recommended === index ? "Recommended" : undefined}
            onPress={() => {
              onToggle(option.label);
            }}
          />
        ))}
      </View>
      {/* omp always allows a typed answer when none of the options fit ("Other"). */}
      <TextInput
        value={custom}
        onChangeText={onCustom}
        placeholder="Or type your own answer…"
        placeholderTextColor={colors.textFaint}
        style={[
          styles.custom,
          { borderColor: custom.length > 0 ? colors.accent : colors.hairline, backgroundColor: colors.surface, color: colors.text },
        ]}
        multiline
      />
    </View>
  );
}

/**
 * A pending `ask` from omp, answered from the phone as a paginated stepper: one question at a
 * time. Picking a single-select option auto-advances; multi-select waits for Next. Every question
 * also takes a typed answer, and the whole ask can be cancelled. Back keeps earlier answers; the
 * state rules live in `askState.ts`. The caller keys the card by ask id so a new ask starts fresh.
 */
export function AskCard({ ask, onSubmit, onCancel }: AskCardProps) {
  const colors = useColors();
  const { height: windowHeight } = useWindowDimensions();
  const [draft, dispatch] = useReducer((state: AskDraft, action: AskAction) => reduceAsk(ask, state, action), initialDraft);
  // A single-select pick shows for a beat, then the card moves on. The timer lives in an effect so
  // leaving the card or picking again clears it; `advance` also ignores a page the card already left.
  const [advanceFrom, setAdvanceFrom] = useState<number | null>(null);
  useEffect(() => {
    if (advanceFrom === null) return;
    const from = advanceFrom;
    const timer = setTimeout(() => {
      dispatch({ type: "advance", from });
      setAdvanceFrom(null);
    }, 180);
    return () => { clearTimeout(timer); };
  }, [advanceFrom]);
  const total = ask.questions.length;
  const index = Math.min(draft.step, total - 1);
  const question = ask.questions[index];
  if (question === undefined) return null;
  const multi = question.multi === true;
  const current = draft.selections[question.id] ?? [];
  const isLast = index >= total - 1;
  const canAdvance = isAnswered(draft, question.id);
  const missing = firstUnanswered(ask, draft);

  const onToggle = (label: string): void => {
    dispatch({ type: "pick", index, label });
    if (advancesOnPick(ask, index)) setAdvanceFrom(index);
  };

  // Submit never sits dead: with a page still unanswered it takes the user there instead.
  const submit = (): void => {
    if (missing >= 0) dispatch({ type: "goto", index: missing });
    else onSubmit(answersOf(ask, draft));
  };

  return (
    <Card maxHeight={Math.min(400, Math.round(windowHeight * 0.55))}>
      <View style={styles.header}>
        {total > 1 ? (
          <View style={styles.progress}>
            {ask.questions.map((q, i) => (
              <View
                key={q.id}
                style={[
                  styles.dot,
                  { backgroundColor: i === index ? colors.accent : isAnswered(draft, q.id) ? colors.textFaint : colors.hairline },
                ]}
              />
            ))}
            <Text variant="caption" color="textFaint" style={{ marginLeft: spacing.sm }}>
              {index + 1} / {total}
            </Text>
          </View>
        ) : (
          <View />
        )}
        <Pressable hitSlop={8} onPress={onCancel}>
          <Text variant="caption" color="textMuted">
            Cancel
          </Text>
        </Pressable>
      </View>
      <ScrollView style={styles.body} contentContainerStyle={{ gap: spacing.lg, padding: spacing.lg, paddingTop: spacing.sm }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Question
          question={question}
          selected={current}
          custom={draft.customs[question.id] ?? ""}
          onToggle={onToggle}
          onCustom={(text) => { dispatch({ type: "custom", index, text }); }}
        />
      </ScrollView>
      <View style={[styles.footer, { borderTopColor: colors.hairline }]}>
        <Button label="Back" variant="ghost" disabled={index === 0} onPress={() => { dispatch({ type: "back" }); }} />
        {isLast ? (
          <Button label={missing >= 0 ? `Answer page ${String(missing + 1)}` : "Submit"} onPress={submit} />
        ) : (
          <Button label={multi && current.length > 0 ? `Next (${String(current.length)})` : "Next"} disabled={!canAdvance} onPress={() => { dispatch({ type: "advance", from: index }); }} />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  /** Takes the room the header and footer leave in a height-capped card, scrolling past it, so Back / Next / Submit stay on screen. */
  body: {
    flexGrow: 0,
    flexShrink: 1,
  },
  progress: {
    flexDirection: "row",
    alignItems: "center",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: spacing.xs,
  },
  custom: {
    borderRadius: radii.md,
    borderWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    minHeight: 40,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    padding: spacing.md,
  },
});
