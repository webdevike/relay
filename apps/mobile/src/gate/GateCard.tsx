import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { AgentImage, GateStatus } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Pill } from "@/ui/Pill";
import { OptionRow } from "@/ui/OptionRow";
import { TextField } from "@/ui/TextField";
import { TimerReadout } from "@/ui/TimerReadout";
import { ImageFrame } from "@/ui/ImageFrame";
import { spacing, useColors } from "@/theme";
import { notifyHaptic } from "@/lib/haptics";
import { activeChoice, gateChoices, gatePhase, secondsLeft, timerProgress, type GateChoice } from "@/lib/gate";
import { choosePhoto, type Photo, type PhotoSource } from "@/lib/photo";

const PREVIEW_SIZE = 120;

export interface GateCardProps {
  gate: GateStatus;
  /** Each resolves once the host accepted it and rejects with the host's reason. */
  onStart: (id: string) => Promise<void>;
  onDone: (id: string, photo: AgentImage | undefined) => Promise<void>;
  onOverride: (reason: string) => Promise<void>;
}

function describe(choice: GateChoice): string {
  const length = choice.minutes === null ? "No timer" : `${choice.minutes} min`;
  return choice.photo ? `${length}, photo proof` : length;
}

/**
 * The locked habit gate: pick a habit or task and start its timer, wait it out, then mark it
 * done (with a proof photo when the habit asks for one). Override unlocks without a habit and
 * takes a typed reason, which the gate logs.
 */
export function GateCard({ gate, onStart, onDone, onOverride }: GateCardProps) {
  const colors = useColors();
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = gate.active !== null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);

  const phase = gatePhase(gate, now);
  const active = activeChoice(gate);
  const needsPhoto = active?.photo === true;

  /** Runs one host command, showing its failure on the card. */
  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    action().then(
      () => {
        setBusy(false);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(failure instanceof Error ? failure.message : String(failure));
        notifyHaptic("error");
      },
    );
  };

  const takePhoto = (source: PhotoSource): void => {
    setError(null);
    choosePhoto(source).then(
      (picked) => {
        if (picked !== null) setPhoto(picked);
      },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  };

  const finish = (): void => {
    if (gate.active === null) return;
    const id = gate.active.id;
    run(async () => {
      await onDone(id, photo?.image);
      notifyHaptic("success");
    });
  };

  return (
    <Card maxHeight={560}>
      <View style={styles.header}>
        <Pill label={overriding ? "Override" : "Break time"} tone={overriding ? "danger" : "warn"} />
        {!overriding && (
          <Pressable
            hitSlop={8}
            onPress={() => {
              setError(null);
              setOverriding(true);
            }}
          >
            <Text variant="caption" color="textMuted">
              Override
            </Text>
          </Pressable>
        )}
      </View>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {overriding ? (
          <>
            <Text variant="label">Why skip this break?</Text>
            <TextField value={reason} onChangeText={setReason} placeholder="Reason" multiline />
            <Text variant="caption" color="textMuted">
              The reason is logged with today&apos;s history.
            </Text>
          </>
        ) : phase === "pick" ? (
          <>
            <Text variant="title">AI tools are paused</Text>
            <Text variant="caption" color="textMuted">
              Pick a habit or task and start it to unlock.
            </Text>
            {gateChoices(gate).map((choice) => (
              <OptionRow
                key={`${choice.kind}:${choice.id}`}
                label={choice.name}
                description={describe(choice)}
                selected={selected === choice.id}
                badge={choice.kind === "task" ? "Task" : undefined}
                onPress={() => {
                  setSelected(choice.id);
                }}
              />
            ))}
          </>
        ) : (
          <>
            <Text variant="title">{active?.name ?? gate.active?.id}</Text>
            {phase === "running" && gate.active !== null ? (
              <>
                <TimerReadout seconds={secondsLeft(gate.active, now)} fraction={timerProgress(gate.active, now)} />
                <Text variant="caption" color="textMuted" style={styles.centered}>
                  AI tools unlock when this is done.
                </Text>
              </>
            ) : (
              <Text variant="caption" color="textMuted">
                {needsPhoto ? "Time is up. Add a photo as proof, then mark it done." : "Time is up. Mark it done to unlock."}
              </Text>
            )}
            {phase === "finish" && needsPhoto && (
              <View style={styles.photoRow}>
                {photo !== null && <ImageFrame uri={photo.uri} width={PREVIEW_SIZE} height={PREVIEW_SIZE} resizeMode="cover" alt="Proof photo" />}
                <View style={styles.photoButtons}>
                  <Button
                    label={photo === null ? "Take photo" : "Retake"}
                    variant="secondary"
                    onPress={() => {
                      takePhoto("camera");
                    }}
                  />
                  <Button
                    label="Choose photo"
                    variant="ghost"
                    onPress={() => {
                      takePhoto("library");
                    }}
                  />
                </View>
              </View>
            )}
          </>
        )}
        {error !== null && (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        )}
      </ScrollView>
      <View style={[styles.footer, { borderTopColor: colors.hairline }]}>
        {overriding ? (
          <>
            <Button
              label="Back"
              variant="ghost"
              onPress={() => {
                setError(null);
                setOverriding(false);
              }}
            />
            <Button
              label="Override"
              variant="danger"
              loading={busy}
              disabled={reason.trim().length === 0}
              onPress={() => {
                run(() => onOverride(reason.trim()));
              }}
            />
          </>
        ) : phase === "pick" ? (
          <Button
            label="Start"
            loading={busy}
            disabled={selected === null}
            onPress={() => {
              if (selected !== null) run(() => onStart(selected));
            }}
          />
        ) : (
          <Button label="Done" tone="ok" loading={busy} disabled={phase !== "finish" || (needsPhoto && photo === null)} onPress={finish} />
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
  body: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingTop: spacing.md,
  },
  centered: { textAlign: "center" },
  photoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  photoButtons: { gap: spacing.sm, flex: 1 },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.md,
    borderTopWidth: 1,
    padding: spacing.md,
  },
});
