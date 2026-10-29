/**
 * One job in Studio's queue: a flat row (thumb or mode glyph, prompt, backend and state, a thin
 * progress bar with the time left) and an icon button that cancels it, or for a failed job its
 * error with Remix and an x that clears it.
 */
import { View } from "react-native";
import { SymbolView } from "expo-symbols";
import { studioEtaLabel, type StudioJob } from "@relay/protocol";
import { radii, spacing, useColors, type ToneToken } from "@/theme";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { ImageFrame } from "@/ui/ImageFrame";
import { Pill } from "@/ui/Pill";
import { ProgressBar } from "@/ui/ProgressBar";
import { Text } from "@/ui/Text";

const THUMB = 48;

const STATES: Record<StudioJob["state"], { label: string; tone: ToneToken }> = {
  queued: { label: "Queued", tone: "textMuted" },
  running: { label: "Running", tone: "accent" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "textMuted" },
};

export interface QueueRowProps {
  job: StudioJob;
  backendLabel: string;
  /** Thumbnail URL of a frame the job starts from, if any. */
  thumb: string | null;
  busy: boolean;
  onCancel: () => void;
  onRemix: () => void;
  onDismiss: () => void;
}

export function QueueRow({ job, backendLabel, thumb, busy, onCancel, onRemix, onDismiss }: QueueRowProps) {
  const colors = useColors();
  const state = STATES[job.state];
  const failed = job.state === "failed";
  const detail = [job.note, studioEtaLabel(job.etaMs)].filter((part) => part !== undefined).join(", ");
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingHorizontal: spacing.xl, paddingVertical: spacing.md }}>
      {thumb === null ? (
        <View style={{ width: THUMB, height: THUMB, borderRadius: radii.sm, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" }}>
          <SymbolView name={job.spec.mode === "video" ? "video" : "photo"} size={20} tintColor={colors.textMuted} />
        </View>
      ) : (
        <ImageFrame uri={thumb} width={THUMB} height={THUMB} resizeMode="cover" />
      )}
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Text variant="body" numberOfLines={1}>
          {job.spec.prompt}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Pill label={state.label} tone={state.tone} />
          <Text variant="caption" color="textMuted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {backendLabel}
          </Text>
        </View>
        {failed ? (
          <>
            {job.error !== undefined && (
              <Text variant="caption" color="danger" numberOfLines={3}>
                {job.error}
              </Text>
            )}
            <View style={{ flexDirection: "row" }}>
              <Button label="Remix" variant="secondary" height={44} onPress={onRemix} />
            </View>
          </>
        ) : (
          <>
            <ProgressBar fraction={job.progress} tone={job.state === "running" ? "accent" : "textMuted"} />
            {detail.length > 0 && (
              <Text variant="caption" color="textMuted" numberOfLines={1}>
                {detail}
              </Text>
            )}
          </>
        )}
      </View>
      <IconButton
        symbol="xmark"
        size={44}
        disabled={busy}
        accessibilityLabel={failed ? "Clear failed job" : "Cancel job"}
        onPress={failed ? onDismiss : onCancel}
      />
    </View>
  );
}
