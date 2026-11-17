/**
 * Trial mode in an assistant thread (protocol "trials"): a taste agent ran one request on two or
 * three models and Isaac judges the results blind. `TrialCard` stacks them under BIG letters (A, B,
 * C; no model names), each result filling in as its model finishes, with A / B / C / Can't tell
 * under them. After the pick the buttons go, each result shows its model under the letter and the
 * picked one is marked. `TrialSwitchRow` is the agent's own message after it switched model on his
 * picks, with Undo.
 *
 * Both are rows of the thread list placed by time (`lib/trials.ts` `threadTrialRows`). What they
 * show is derived from the host's snapshot (`state/trials`) and this phone's unanswered pick or
 * undo; there is no state of their own. A card or switch that arrives live, and every result that
 * fills a card in, keeps the list's place first (`useKeptArrival`), as a reply's follow-up widget.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import type { Trial, TrialArm, TrialSwitch } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { useKeptArrival } from "@/agents/ReplyFollowUp";
import { pickTrial, undoTrialSwitch } from "@/connection";
import {
  armsInOrder,
  armStateText,
  canUndoSwitch,
  switchLine,
  trialChoices,
  trialHeader,
} from "@/lib/trials";
import { useTrialsStore } from "@/state/trials";
import { radii, spacing, toneFill, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { ChefHatIcon } from "@/ui/ChefHatIcon";
import { Pill } from "@/ui/Pill";
import { StatusCardRow } from "@/ui/StatusCardRow";
import { Text } from "@/ui/Text";

const RADIUS = 22;
/** The buttons are full touch targets. */
const TAP = 44;

/** Whether card or switch `id` may show yet: one that arrived live keeps the list's place first, once. */
function useTrialArrival(id: string): boolean {
  const fresh = useTrialsStore((state) => state.fresh.includes(id));
  // Only a row that was new when it first drew waits; a recycled row never does again.
  const [live] = useState(fresh);
  useEffect(() => {
    if (fresh) useTrialsStore.getState().settle(id);
  }, [fresh, id]);
  return useKeptArrival(live);
}

export interface TrialCardProps {
  trial: Trial;
  /** The host can take a pick now. */
  connected: boolean;
  /** The thread's incoming bubble fill. */
  fill: string;
}

export function TrialCard({ trial, connected, fill }: TrialCardProps) {
  const colors = useColors();
  const shown = useTrialArrival(trial.id);
  const sending = useTrialsStore((state) => state.picking[trial.id]);
  if (!shown) return null;
  const choices = trialChoices(trial, sending, connected);
  return (
    <View style={styles.row}>
      <View style={[styles.card, { backgroundColor: fill }]} testID="trial-card">
        <Text variant="label" color="textMuted" numberOfLines={1}>
          {trialHeader(trial)}
        </Text>
        {armsInOrder(trial).map((arm, index) => (
          <View key={arm.letter}>
            {index > 0 && <View style={[styles.divider, { backgroundColor: colors.hairline }]} />}
            <ArmPane arm={arm} trial={trial} />
          </View>
        ))}
        {choices.length > 0 && (
          <View
            style={[styles.choices, { borderTopColor: colors.hairline }]}
            accessibilityRole="toolbar"
            accessibilityLabel="Which is better?"
          >
            {choices.map((choice) => (
              <View
                key={choice.pick}
                style={choice.pick === "unsure" ? styles.unsure : styles.letterChoice}
              >
                <Button
                  label={choice.label}
                  variant="secondary"
                  height={TAP}
                  disabled={!choice.enabled}
                  loading={choice.sending}
                  accessibilityLabel={
                    choice.pick === "unsure" ? "Can't tell" : `Pick ${choice.label}`
                  }
                  testID={`trial-pick-${choice.pick}`}
                  onPress={() => {
                    pickTrial(trial.id, choice.pick);
                  }}
                />
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** One result: its BIG letter (the model under it once picked), then the result, or where it stands. */
function ArmPane({ arm, trial }: { arm: TrialArm; trial: Trial }) {
  const colors = useColors();
  // A result that comes in while the card shows keeps the list's place before it grows the card.
  const [startedRunning] = useState(arm.status === "running");
  const shown = useKeptArrival(startedRunning && arm.status === "done");
  const picked = trial.pick === arm.letter;
  const revealed = trial.pick !== undefined ? arm.modelLabel : undefined;
  // Until it may show, a result that just came in still reads as running.
  const state = armStateText(shown ? arm : { ...arm, status: "running" });
  return (
    <View
      style={[styles.pane, picked && { backgroundColor: toneFill(colors, "accent", 0.12) }]}
      testID={`trial-arm-${arm.letter}`}
    >
      <View style={styles.head}>
        <View style={styles.letterColumn}>
          <Text
            style={[styles.letter, { color: picked ? colors.accent : colors.text }]}
            accessibilityLabel={`Result ${arm.letter}`}
          >
            {arm.letter}
          </Text>
          {revealed !== undefined && (
            <Text
              variant="label"
              color="textMuted"
              numberOfLines={1}
              testID={`trial-model-${arm.letter}`}
            >
              {revealed}
            </Text>
          )}
        </View>
        {picked && <Pill label="Your pick" tone="accent" />}
      </View>
      {state !== null ? (
        <View style={styles.state}>
          {arm.status === "running" || !shown ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : null}
          <Text variant="body" color="textMuted">
            {state}
          </Text>
        </View>
      ) : arm.preview !== undefined && arm.preview.trim() !== "" ? (
        <MessageText text={arm.preview} />
      ) : null}
    </View>
  );
}

export interface TrialSwitchRowProps {
  entry: TrialSwitch;
}

/** The agent's own message after it switched model on Isaac's picks: its words and Undo, or what Undo did. */
export function TrialSwitchRow({ entry }: TrialSwitchRowProps) {
  const colors = useColors();
  const shown = useTrialArrival(entry.id);
  const undoing = useTrialsStore((state) => state.undoing[entry.id] === true);
  if (!shown) return null;
  const line = switchLine(entry);
  return (
    <View style={styles.row}>
      <StatusCardRow
        id={`trial-switch:${entry.id}`}
        running={false}
        line={line}
        lineLines={3}
        lineColor={entry.undone ? "textMuted" : "text"}
        lead={<ChefHatIcon size={14} color={colors.textMuted} />}
        actions={
          canUndoSwitch(entry) ? (
            <Button
              label="Undo"
              variant="ghost"
              height={TAP}
              loading={undoing}
              accessibilityLabel={`Undo, back on ${entry.fromLabel}`}
              testID="trial-switch-undo"
              onPress={() => {
                undoTrialSwitch(entry.id);
              }}
            />
          ) : undefined
        }
        testID="trial-switch"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: spacing.lg },
  card: {
    borderRadius: RADIUS,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
  },
  pane: {
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    gap: spacing.sm,
  },
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  letterColumn: { flexShrink: 1 },
  divider: { height: StyleSheet.hairlineWidth },
  letter: { fontSize: 34, lineHeight: 38, fontWeight: "700" },
  state: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  choices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  letterChoice: { flexGrow: 1, flexBasis: 56 },
  unsure: { flexGrow: 2 },
});
