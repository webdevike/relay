import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { AgentAsk, AgentAskQuestion } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { colors, radii, spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

/** One answer per question: chosen option labels, or free text the user typed instead. */
export interface AskAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

export interface AskCardProps {
  ask: AgentAsk;
  onSubmit: (results: AskAnswer[]) => void;
  /** Dismiss the ask without answering (omp's dialog resolves as cancelled). */
  onCancel: () => void;
}

/** Toggles `label` in a selection: multi-select adds/removes, single-select replaces. */
function toggle(current: string[], label: string, multi: boolean): string[] {
  if (current.includes(label)) return current.filter((entry) => entry !== label);
  return multi ? [...current, label] : [label];
}

interface OptionRowProps {
  label: string;
  description: string | undefined;
  selected: boolean;
  recommended: boolean;
  onPress: () => void;
}

function OptionRow({ label, description, selected, recommended, onPress }: OptionRowProps) {
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.hairline,
        backgroundColor: selected ? "rgba(124,156,255,0.12)" : colors.surface,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="body" color={selected ? "accent" : "text"} style={{ flex: 1 }}>
          {label}
        </Text>
        {recommended && (
          <Text variant="caption" color="accent">
            Recommended
          </Text>
        )}
      </View>
      {description !== undefined && description.length > 0 && (
        <Text variant="caption" color="textMuted" style={{ marginTop: spacing.xs }}>
          {description}
        </Text>
      )}
    </Pressable>
  );
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
            recommended={question.recommended === index}
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
        style={[styles.custom, custom.length > 0 ? styles.customActive : null]}
        multiline
      />
    </View>
  );
}

/** Whether a question has an answer: a picked option or typed text. */
function answered(selected: string[] | undefined, custom: string | undefined): boolean {
  return (selected?.length ?? 0) > 0 || (custom?.trim().length ?? 0) > 0;
}

/**
 * A pending `ask` from omp, answered from the phone as a paginated stepper: one question at a
 * time. Picking a single-select option auto-advances; multi-select waits for Next. Every question
 * also takes a typed answer, and the whole ask can be cancelled. Back keeps earlier answers.
 */
export function AskCard({ ask, onSubmit, onCancel }: AskCardProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [customs, setCustoms] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const total = ask.questions.length;
  const question = ask.questions[Math.min(step, total - 1)];
  if (question === undefined) return null;
  const multi = question.multi === true;
  const current = selections[question.id] ?? [];
  const isLast = step >= total - 1;
  const canAdvance = answered(current, customs[question.id]);
  const complete = ask.questions.every((q) => answered(selections[q.id], customs[q.id]));

  const onToggle = (label: string): void => {
    setSelections((prev) => ({ ...prev, [question.id]: multi ? toggle(prev[question.id] ?? [], label, true) : [label] }));
    // A picked option supersedes any typed answer for that question.
    setCustoms((prev) => ({ ...prev, [question.id]: "" }));
    if (!multi && !isLast) setTimeout(() => setStep((s) => Math.min(s + 1, total - 1)), 180);
  };

  const onCustom = (text: string): void => {
    setCustoms((prev) => ({ ...prev, [question.id]: text }));
    // Typing an answer clears the option selection so submit sends the free text.
    if (text.length > 0) setSelections((prev) => ({ ...prev, [question.id]: [] }));
  };

  const submit = (): void => {
    onSubmit(
      ask.questions.map((q) => {
        const custom = customs[q.id]?.trim() ?? "";
        return custom.length > 0 ? { id: q.id, selectedOptions: [], customInput: custom } : { id: q.id, selectedOptions: selections[q.id] ?? [] };
      }),
    );
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        {total > 1 ? (
          <View style={styles.progress}>
            {ask.questions.map((q, i) => (
              <View key={q.id} style={[styles.dot, i === step ? styles.dotActive : answered(selections[q.id], customs[q.id]) ? styles.dotDone : null]} />
            ))}
            <Text variant="caption" color="textFaint" style={{ marginLeft: spacing.sm }}>
              {step + 1} / {total}
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
      <ScrollView contentContainerStyle={{ gap: spacing.lg, padding: spacing.lg, paddingTop: spacing.sm }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Question question={question} selected={current} custom={customs[question.id] ?? ""} onToggle={onToggle} onCustom={onCustom} />
      </ScrollView>
      <View style={styles.footer}>
        <Button label="Back" variant="ghost" disabled={step === 0} onPress={() => setStep((s) => Math.max(0, s - 1))} />
        {isLast ? (
          <Button label="Submit" disabled={!complete} onPress={submit} />
        ) : (
          <Button label="Next" disabled={!canAdvance} onPress={() => setStep((s) => Math.min(s + 1, total - 1))} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceRaised,
    overflow: "hidden",
    maxHeight: 400,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
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
    backgroundColor: colors.hairline,
  },
  dotActive: { backgroundColor: colors.accent },
  dotDone: { backgroundColor: colors.textFaint },
  custom: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: 15,
    minHeight: 40,
  },
  customActive: { borderColor: colors.accent },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    padding: spacing.md,
  },
});
