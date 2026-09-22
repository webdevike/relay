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
 * A pending `ask` from omp, answered from the phone. Each question keeps its own selection; a
 * single-select question holds one option, a multi-select toggles. Submit stays disabled until
 * every question has at least one selection, then hands back the chosen labels per question.
 */
export function AskCard({ ask, onSubmit }: AskCardProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const complete = ask.questions.every((question) => (selections[question.id]?.length ?? 0) > 0);

  const onToggle = (question: AgentAskQuestion, label: string): void => {
    setSelections((prev) => ({
      ...prev,
      [question.id]: toggle(prev[question.id] ?? [], label, question.multi === true),
    }));
  };

  return (
    <View style={styles.card}>
      <ScrollView
        contentContainerStyle={{ gap: spacing.lg, padding: spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        {ask.questions.map((question) => (
          <Question
            key={question.id}
            question={question}
            selected={selections[question.id] ?? []}
            onToggle={(label) => {
              onToggle(question, label);
            }}
          />
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Button
          label="Submit"
          disabled={!complete}
          onPress={() => {
            onSubmit(
              ask.questions.map((question) => ({
                id: question.id,
                selectedOptions: selections[question.id] ?? [],
              })),
            );
          }}
        />
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
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    padding: spacing.md,
  },
});
