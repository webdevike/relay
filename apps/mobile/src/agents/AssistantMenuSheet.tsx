import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { AgentModel, AssistantPortrait } from "@relay/protocol";
import { OverlaySheet } from "@/ui/OverlaySheet";
import { Portrait } from "@/ui/Portrait";
import { IconButton } from "@/ui/IconButton";
import { DotSlider } from "@/ui/DotSlider";
import { Text } from "@/ui/Text";
import { spacing, useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import {
  joinModel,
  levelFor,
  levelLabel,
  resolveCurrent,
  shortModelName,
  splitModel,
} from "@/agents/assistantModel";

export interface AssistantMenuItem {
  key: string;
  symbol: SFSymbol;
  label: string;
  /** A quiet line under the label. */
  hint?: string;
  onPress: () => void;
}

export interface AssistantMenuSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  portrait: AssistantPortrait;
  /** The models the assistant's session offers, with their levels; empty while it has no session or the host is older. */
  models: readonly AgentModel[];
  /** The registry's model for the assistant (`assistant.agents`), with its thinking suffix. */
  registryModel: string | undefined;
  /** What the running session reports, for an assistant whose registry names no model. */
  sessionModel: string | undefined;
  sessionThinking: string | undefined;
  /** False while offline: a registry write could not reach the host. */
  connected: boolean;
  /** Writes the registry's `provider/id[:level]`; applies when the assistant's session next starts. */
  onSetModel: (model: string) => void;
  items: readonly AssistantMenuItem[];
}

/**
 * The assistant's menu, a bottom sheet over its thread (tap its avatar): the model and thinking
 * level on top, both written to the host's registry, then what it can do. Quiet by design: hairline
 * dividers, one label scale, the accent only on what is chosen.
 */
export function AssistantMenuSheet({
  open,
  onClose,
  title,
  portrait,
  models,
  registryModel,
  sessionModel,
  sessionThinking,
  connected,
  onSetModel,
  items,
}: AssistantMenuSheetProps) {
  const colors = useColors();
  const { model, level } = resolveCurrent(models, registryModel, sessionModel, sessionThinking);
  const levels = model?.thinkingLevels ?? [];
  const known = level === undefined ? -1 : levels.indexOf(level);
  const [index, setIndex] = useState(Math.max(0, known));
  const [picking, setPicking] = useState(false);
  // The registry (or a change from elsewhere) names a different level than the slider shows: follow it.
  useEffect(() => {
    setIndex(Math.max(0, known));
  }, [known, model?.id]);
  useEffect(() => {
    if (!open) setPicking(false);
  }, [open]);

  const base = model === undefined ? undefined : `${model.provider}/${model.id}`;
  const shown = levels[index];
  const canWrite = connected && base !== undefined;
  const commit = (next: number): void => {
    const picked = levels[next];
    if (base === undefined || picked === undefined || picked === level) return;
    onSetModel(joinModel(base, picked));
  };
  const choose = (entry: AgentModel): void => {
    setPicking(false);
    const entryBase = `${entry.provider}/${entry.id}`;
    if (entryBase === base) return;
    onSetModel(joinModel(entryBase, levelFor(entry.thinkingLevels, level)));
  };
  const modelLabel =
    model === undefined
      ? registryModel === undefined
        ? sessionModel
        : splitModel(registryModel).base
      : shortModelName(model.name);

  return (
    <OverlaySheet
      open={open}
      onClose={onClose}
      header={
        <View style={[styles.head, { borderBottomColor: colors.hairline }]}>
          <Portrait name={title} portrait={portrait} size={36} />
          <Text variant="title" style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <IconButton
            symbol="xmark"
            size={34}
            accessibilityLabel={`Close ${title} menu`}
            onPress={onClose}
          />
        </View>
      }
    >
      <View testID="assistant-menu-model">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: picking, disabled: models.length === 0 }}
          accessibilityLabel={`Model, ${modelLabel ?? "unknown"}`}
          disabled={models.length === 0}
          onPress={() => {
            tapHaptic();
            setPicking((current) => !current);
          }}
          style={({ pressed }) => [
            styles.row,
            pressed && { backgroundColor: colors.surfaceRaised },
          ]}
        >
          <Text variant="body" style={styles.fill}>
            Model
          </Text>
          <Text variant="body" color="textMuted" numberOfLines={1} style={styles.value}>
            {modelLabel ?? "Not reported"}
          </Text>
          {models.length > 0 && (
            <SymbolView
              name={picking ? "chevron.up" : "chevron.down"}
              size={12}
              tintColor={colors.textMuted}
            />
          )}
        </Pressable>
        {picking &&
          models.map((entry) => {
            const selected = `${entry.provider}/${entry.id}` === base;
            return (
              <Pressable
                key={`${entry.provider}/${entry.id}`}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: !connected }}
                disabled={!connected}
                onPress={() => {
                  tapHaptic();
                  choose(entry);
                }}
                style={({ pressed }) => [
                  styles.choice,
                  pressed && { backgroundColor: colors.surfaceRaised },
                ]}
              >
                <Text
                  variant="body"
                  color={selected ? "accent" : "text"}
                  style={styles.fill}
                  numberOfLines={1}
                >
                  {shortModelName(entry.name)}
                </Text>
                {selected && <SymbolView name="checkmark" size={14} tintColor={colors.accent} />}
              </Pressable>
            );
          })}
      </View>

      <View style={[styles.rule, { backgroundColor: colors.hairline }]} />

      <View style={styles.thinking} testID="assistant-menu-thinking">
        <View style={styles.thinkingHead}>
          <Text variant="body" style={styles.fill}>
            Thinking
          </Text>
          <Text variant="body" color="textMuted">
            {shown === undefined ? "Not reported" : levelLabel(shown)}
          </Text>
        </View>
        {levels.length > 0 && (
          <View
            style={canWrite ? undefined : styles.dim}
            pointerEvents={canWrite ? "auto" : "none"}
          >
            <DotSlider
              steps={levels.map(levelLabel)}
              index={index}
              onChange={setIndex}
              onCommit={commit}
              accessibilityLabel={`${title} thinking level`}
            />
          </View>
        )}
        <Text variant="caption" color="textMuted">
          {connected
            ? `Applies the next time ${title} starts.`
            : "Connect to the host to change this."}
        </Text>
      </View>

      <View style={[styles.rule, { backgroundColor: colors.hairline }]} />

      {items.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={() => {
            tapHaptic();
            item.onPress();
          }}
          style={({ pressed }) => [
            styles.row,
            pressed && { backgroundColor: colors.surfaceRaised },
          ]}
        >
          <SymbolView
            name={item.symbol}
            size={18}
            tintColor={colors.textMuted}
            style={styles.glyph}
          />
          <View style={styles.fill}>
            <Text variant="body">{item.label}</Text>
            {item.hint !== undefined && (
              <Text variant="caption" color="textMuted">
                {item.hint}
              </Text>
            )}
          </View>
        </Pressable>
      ))}
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1 },
  fill: { flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  value: { flexShrink: 1, textAlign: "right" },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    paddingLeft: spacing.xl + spacing.lg,
    paddingRight: spacing.xl,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.xl,
    marginVertical: spacing.sm,
  },
  thinking: { paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, gap: spacing.sm },
  thinkingHead: { flexDirection: "row", alignItems: "center" },
  dim: { opacity: 0.4 },
  glyph: { width: 18, height: 18 },
});
