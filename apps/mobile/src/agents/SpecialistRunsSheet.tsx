import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { agentBadge, agentRunKey, type AgentRun } from "@relay/protocol";
import { Button } from "@/ui/Button";
import { ChefHatIcon } from "@/ui/ChefHatIcon";
import { IconButton } from "@/ui/IconButton";
import { OverlaySheet } from "@/ui/OverlaySheet";
import { Text } from "@/ui/Text";
import { finishedSpecialists } from "@/lib/specialistChips";
import { useSecondClock } from "@/lib/useSecondClock";
import { radii, spacing, useColors, type ColorToken } from "@/theme";
import { RunDetail } from "./AgentsCaption";

export interface SpecialistRunsSheetProps {
  /** The thread's specialist runs now (the chips' list), newest first. The sheet stays closed when empty. */
  runs: readonly AgentRun[];
  /** The tapped chip's `agentRunKey`, shown opened; null keeps the sheet closed. */
  openKey: string | null;
  onClose: () => void;
  /** Clears these finished runs (a running one cannot be cleared), for every device through the host. */
  onClear: (runs: AgentRun[]) => void;
}

/**
 * A specialist chip opened (`agents/RunningChips`), as the subagents sheet is for session chips: one row per
 * specialist run with its status and clock, the tapped one opened to its details (`RunDetail`: model with
 * `(backup)`, what was asked, the answer or error, reply fields, sources). The x clears one finished run and
 * "Clear finished" every finished one, like desktop's Clear done. Live while it runs. The list is drawn even
 * while closed so the sheet's dynamic height is measured before it first opens.
 */
export function SpecialistRunsSheet({ runs, openKey, onClose, onClear }: SpecialistRunsSheetProps) {
  const colors = useColors();
  const now = useSecondClock(runs.some((run) => run.status === "running"));
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (openKey !== null) setOpened(new Set([openKey]));
  }, [openKey]);
  const finished = finishedSpecialists(runs);
  const open = openKey !== null && runs.length > 0;
  return (
    <OverlaySheet
      open={open}
      onClose={onClose}
      header={
        <View style={[styles.head, { borderBottomColor: colors.hairline }]}>
          <Text variant="title" numberOfLines={1} style={styles.title}>
            {`Specialists · ${String(runs.length)}`}
          </Text>
          {finished.length > 0 && (
            <Button
              label="Clear finished"
              variant="secondary"
              onPress={() => {
                onClear(finished);
              }}
            />
          )}
          <IconButton
            symbol="xmark"
            size={34}
            accessibilityLabel="Close specialists"
            onPress={onClose}
          />
        </View>
      }
    >
      <View style={styles.body} testID="specialist-runs">
        {runs.map((run) => {
          const key = agentRunKey(run);
          const badge = agentBadge(run, now);
          const tone: ColorToken =
            badge.state === "running"
              ? "accent"
              : badge.state === "failed"
                ? "danger"
                : "textMuted";
          const isOpen = opened.has(key);
          const said =
            badge.state === "running" ? "Running" : badge.state === "failed" ? "Failed" : "Done";
          return (
            <View
              key={key}
              style={[
                styles.card,
                { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline },
              ]}
            >
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${isOpen ? "Hide" : "Show"} ${badge.label}, ${said.toLowerCase()}`}
                  accessibilityState={{ expanded: isOpen }}
                  onPress={() => {
                    setOpened((previous) => {
                      const next = new Set(previous);
                      if (!next.delete(key)) next.add(key);
                      return next;
                    });
                  }}
                  style={({ pressed }) => [styles.main, pressed && { opacity: 0.7 }]}
                  testID="specialist-run-row"
                >
                  {badge.state === "running" ? (
                    <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />
                  ) : (
                    <SymbolView
                      name={
                        badge.state === "failed" ? "exclamationmark.triangle.fill" : "checkmark"
                      }
                      size={12}
                      tintColor={colors[tone]}
                    />
                  )}
                  <ChefHatIcon size={13} color={colors[tone]} />
                  <View style={styles.text}>
                    <Text variant="label" numberOfLines={1}>
                      {badge.label}
                    </Text>
                    <Text variant="caption" color="textMuted" numberOfLines={1} tabular>
                      {badge.clock === null ? said : `${said} · ${badge.clock}`}
                    </Text>
                  </View>
                  <SymbolView
                    name={isOpen ? "chevron.down" : "chevron.right"}
                    size={13}
                    tintColor={colors.textFaint}
                  />
                </Pressable>
                {run.status !== "running" && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Clear specialist ${badge.label}`}
                    hitSlop={8}
                    onPress={() => {
                      onClear([run]);
                    }}
                    style={({ pressed }) => [styles.clear, pressed && { opacity: 0.6 }]}
                    testID="specialist-run-clear"
                  >
                    <SymbolView name="xmark" size={13} tintColor={colors.textMuted} />
                  </Pressable>
                )}
              </View>
              {isOpen && (
                <View style={styles.detail} testID="specialist-run-details">
                  <RunDetail run={run} first />
                </View>
              )}
            </View>
          );
        })}
      </View>
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1 },
  body: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  card: { borderRadius: radii.md, borderWidth: 1 },
  row: { flexDirection: "row", alignItems: "center" },
  main: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
  },
  text: { flex: 1, gap: 2 },
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
  clear: { padding: spacing.md },
  detail: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
});
