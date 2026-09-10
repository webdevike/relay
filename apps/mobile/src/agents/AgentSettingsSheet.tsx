import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { AgentModel, Command } from "@relay/protocol";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { colors, radii, spacing, type } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { requestAgentOptions, sendCommand } from "@/connection";

const MODEL_LIST_MAX_HEIGHT = 260;

export interface AgentSettingsSheetProps {
  sessionId: string | null;
  onClose: () => void;
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && { opacity: 0.8 }]}
    >
      <Text variant="label" color={selected ? "accent" : "textMuted"}>
        {label}
      </Text>
    </Pressable>
  );
}

function ModelRow({ model, selected, onPress }: { model: AgentModel; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.modelRow, pressed && { opacity: 0.8 }]}>
      <View style={{ flex: 1 }}>
        <Text variant="body" numberOfLines={1}>
          {model.name}
        </Text>
        <Text variant="caption" color="textFaint" numberOfLines={1}>
          {model.provider}
        </Text>
      </View>
      {selected && <SymbolView name="checkmark" size={16} tintColor={colors.accent} />}
    </Pressable>
  );
}

/**
 * Long-press target for a scrubber slot: rename the session, pick its model and thinking level,
 * or stop what it is doing. Each change is sent as soon as it is made; the card updates when the
 * host reports the new settings back.
 */
export function AgentSettingsSheet({ sessionId, onClose }: AgentSettingsSheetProps) {
  const session = useAgentsStore((state) => (sessionId === null ? undefined : state.sessions[sessionId]));
  const models = useAgentsStore((state) => (sessionId === null ? undefined : state.options[sessionId]));
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (sessionId === null) return;
    setTitle(useAgentsStore.getState().sessions[sessionId]?.title ?? "");
    setError(null);
    requestAgentOptions(sessionId);
  }, [sessionId]);

  if (sessionId === null || session === undefined) return null;

  const apply = (cmd: Command): void => {
    setBusy(true);
    setError(null);
    sendCommand(cmd)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "The host rejected that change.");
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const commitTitle = (): void => {
    const next = title.trim();
    if (next.length === 0 || next === session.title) {
      setTitle(session.title);
      return;
    }
    apply({ kind: "agent.configure", sessionId, title: next });
  };

  const current = models?.find((model) => model.name === session.model);
  const thinkingLevels = current?.thinkingLevels ?? (session.thinkingLevel === undefined ? [] : [session.thinkingLevel]);

  return (
    <Sheet visible onClose={onClose}>
      <Section label="Title">
        <TextInput
          value={title}
          onChangeText={setTitle}
          onBlur={commitTitle}
          onSubmitEditing={commitTitle}
          placeholder={session.title}
          placeholderTextColor={colors.textFaint}
          autoCorrect={false}
          returnKeyType="done"
          style={styles.input}
        />
      </Section>
      <Section label="Thinking" trailing={thinkingLevels.length === 0 ? "Not reported" : undefined}>
        <View style={styles.chips}>
          {thinkingLevels.map((level) => (
            <Chip
              key={level}
              label={level}
              selected={level === session.thinkingLevel}
              onPress={() => {
                apply({ kind: "agent.configure", sessionId, thinkingLevel: level });
              }}
            />
          ))}
        </View>
      </Section>
      <Section label="Model" trailing={session.model}>
        {models === undefined ? (
          <Text variant="caption" color="textFaint">
            Loading models…
          </Text>
        ) : models.length === 0 ? (
          <Text variant="caption" color="textFaint">
            No other models available on the host.
          </Text>
        ) : (
          <ScrollView style={styles.modelList} contentContainerStyle={styles.modelListContent} bounces={false}>
            {models.map((model) => (
              <ModelRow
                key={`${model.provider}/${model.id}`}
                model={model}
                selected={model.name === session.model}
                onPress={() => {
                  apply({ kind: "agent.configure", sessionId, model: { provider: model.provider, id: model.id } });
                }}
              />
            ))}
          </ScrollView>
        )}
      </Section>
      {error !== null && (
        <View style={{ marginTop: spacing.md }}>
          <Banner tone="danger" message={error} />
        </View>
      )}
      {session.status === "working" && (
        <View style={{ marginTop: spacing.lg }}>
          <Button
            label="Stop this turn"
            variant="secondary"
            loading={busy}
            onPress={() => {
              apply({ kind: "agent.abort", sessionId });
            }}
          />
        </View>
      )}
    </Sheet>
  );
}

function Section({ label, trailing, children }: { label: string; trailing?: string | undefined; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text variant="label" color="textMuted">
          {label}
        </Text>
        {trailing !== undefined && (
          <Text variant="caption" color="textFaint" numberOfLines={1} style={{ flexShrink: 1 }}>
            {trailing}
          </Text>
        )}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: spacing.xl, gap: spacing.sm },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md },
  input: {
    ...type.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: "transparent",
  },
  chipSelected: { borderColor: colors.accent },
  modelList: { maxHeight: MODEL_LIST_MAX_HEIGHT, borderRadius: radii.md, backgroundColor: colors.surfaceRaised },
  modelListContent: { paddingVertical: spacing.xs },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});
