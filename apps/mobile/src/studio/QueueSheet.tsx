/**
 * The GPU queue: every running and waiting job (engine, Running N% or its note, time left, cancel)
 * and the failures (their error, an x that clears them). Plain rows on hairlines.
 */
import { View } from "react-native";
import { studioEtaLabel, type StudioBackend, type StudioJob } from "@relay/protocol";
import { spacing } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { Separator } from "@/ui/Separator";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { cancelJob, dismissJob } from "./actions";
import type { QueueSummary } from "./library";

export interface QueueSheetProps {
  visible: boolean;
  queue: QueueSummary;
  backends: readonly StudioBackend[];
  onClose: () => void;
}

/** The model's name when the backend lists it, else the backend's label. */
export function engineLabel(job: StudioJob, backends: readonly StudioBackend[]): string {
  const backend = backends.find((b) => b.id === job.spec.backend);
  return backend?.models?.find((m) => m.id === job.spec.model)?.name ?? backend?.label ?? job.spec.backend;
}

function stateLine(job: StudioJob): string {
  if (job.state === "failed") return job.error ?? "Failed";
  if (job.state === "running") return `Running ${Math.min(99, Math.round(job.progress * 100))}%${job.note === undefined ? "" : `, ${job.note}`}`;
  return job.note ?? "Waiting";
}

export function QueueSheet({ visible, queue, backends, onClose }: QueueSheetProps) {
  const rows = [...queue.running, ...queue.waiting, ...queue.failed];
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingTop: spacing.sm }}>
        <Text variant="title" style={{ paddingBottom: spacing.sm }}>
          GPU queue
        </Text>
        {rows.length === 0 && (
          <Text variant="body" color="textMuted">
            Nothing running.
          </Text>
        )}
        {rows.map((job, index) => {
          const failed = job.state === "failed";
          const eta = failed ? undefined : studioEtaLabel(job.etaMs);
          return (
            <View key={job.id}>
              {index > 0 && <Separator />}
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="body" numberOfLines={1}>
                    {failed ? `${engineLabel(job, backends)}, failed` : engineLabel(job, backends)}
                  </Text>
                  <Text variant="caption" color={failed ? "danger" : "textMuted"} numberOfLines={failed ? 3 : 1}>
                    {stateLine(job)}
                  </Text>
                </View>
                {eta !== undefined && (
                  <Text variant="caption" color="textMuted" tabular>
                    {eta}
                  </Text>
                )}
                <IconButton
                  symbol="xmark"
                  size={32}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  accessibilityLabel={failed ? "Clear failed job" : "Cancel job"}
                  onPress={() => {
                    void (failed ? dismissJob(job.id) : cancelJob(job.id));
                  }}
                />
              </View>
            </View>
          );
        })}
      </View>
    </Sheet>
  );
}
