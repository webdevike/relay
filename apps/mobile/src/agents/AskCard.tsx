import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { AgentAsk, AgentAskQuestion } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { colors, radii, spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

export interface AskCardProps {
  ask: AgentAsk;
  /** One answer per question: the chosen option labels. */
  onSubmit: (results: { id: string; selectedOptions: string[] }[]) => void;
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
  onToggle,
}: {
  question: AgentAskQuestion;
  selected: string[];
  onToggle: (label: string) => void;
}) {
  const multi = question.multi === true;
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
    </View>
  );
}

/**
 * A pending `ask` from omp, answered from the phone as a paginated stepper: one question at a
 * time. Picking a single-select answer auto-advances to the next question; multi-select waits for
 * Next. Back revisits earlier answers, which are kept until Submit hands back the labels per question.
 */
export function AskCard({ ask, onSubmit }: AskCardProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [step, setStep] = useState(0);
  const total = ask.questions.length;
  const question = ask.questions[Math.min(step, total - 1)];
  if (question === undefined) return null;
  const multi = question.multi === true;
  const current = selections[question.id] ?? [];
  const isLast = step >= total - 1;
  const complete = ask.questions.every((q) => (selections[q.id]?.length ?? 0) > 0);

  const onToggle = (label: string): void => {
    // Single-select holds exactly one option and steps forward; multi-select toggles and waits.
    setSelections((prev) => ({ ...prev, [question.id]: multi ? toggle(prev[question.id] ?? [], label, true) : [label] }));
    if (!multi && !isLast) setTimeout(() => setStep((s) => Math.min(s + 1, total - 1)), 180);
  };

  const submit = (): void => {
    onSubmit(ask.questions.map((q) => ({ id: q.id, selectedOptions: selections[q.id] ?? [] })));
  };

  return (
    <View style={styles.card}>
      {total > 1 && (
        <View style={styles.progress}>
          {ask.questions.map((q, i) => (
            <View key={q.id} style={[styles.dot, i === step ? styles.dotActive : (selections[q.id]?.length ?? 0) > 0 ? styles.dotDone : null]} />
          ))}
          <Text variant="caption" color="textFaint" style={{ marginLeft: spacing.sm }}>
            {step + 1} / {total}
          </Text>
        </View>
      )}
      <ScrollView contentContainerStyle={{ gap: spacing.lg, padding: spacing.lg }} showsVerticalScrollIndicator={false}>
        <Question question={question} selected={current} onToggle={onToggle} />
      </ScrollView>
      <View style={styles.footer}>
        <Button label="Back" variant="ghost" disabled={step === 0} onPress={() => setStep((s) => Math.max(0, s - 1))} />
        {isLast ? (
          <Button label="Submit" disabled={!complete} onPress={submit} />
        ) : (
          <Button label="Next" disabled={current.length === 0} onPress={() => setStep((s) => Math.min(s + 1, total - 1))} />
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
    maxHeight: 360,
  },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
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
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    padding: spacing.md,
  },
});
