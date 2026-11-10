import { View } from "react-native";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { radii, spacing, useColors } from "@/theme";
import { useDictation, openDictationSettings } from "./useDictation";

const CHIP_WIDTH = 220;

const errorMessage: Record<string, string> = {
  "not-allowed": "Microphone access is off.",
  "service-not-allowed": "Speech recognition isn't available on this device.",
  "audio-capture": "Couldn't capture audio.",
  network: "Network error during recognition.",
  aborted: "Dictation stopped unexpectedly.",
  "no-speech": "Didn't catch that.",
  accessibility_denied: "Relay needs Accessibility access on your Mac.",
  agent_not_found: "That agent session is gone.",
  agent_cannot_respond: "That agent can't take a reply right now.",
  invalid_command: "Mac rejected the transcript.",
  internal: "Something went wrong.",
};

const DEFAULT_ERROR_MESSAGE = "Something went wrong.";

/**
 * The floating chip over a mic that says why dictation did not happen: speech access is off (with
 * Open Settings), the recognizer or the send failed, or nothing was heard. Absolutely placed
 * `bottom` points above the mic's own top edge; renders nothing while all is well.
 */
export function DictationStatus({ bottom }: { bottom: number }) {
  const colors = useColors();
  const { phase, errorCode, nothingHeard } = useDictation();
  const denied = phase === "permission_denied";
  const failed = phase === "error";
  const silent = phase === "idle" && nothingHeard;
  if (!denied && !failed && !silent) return null;
  return (
    <View
      style={{
        position: "absolute",
        bottom,
        width: CHIP_WIDTH,
        backgroundColor: colors.surfaceRaised,
        borderRadius: radii.md,
        padding: spacing.md,
        gap: spacing.sm,
      }}
    >
      {denied && <Banner tone="warn" message="Speech recognition access is off." actionLabel="Open Settings" onAction={openDictationSettings} />}
      {failed && <Banner tone="danger" message={errorMessage[errorCode ?? "internal"] ?? DEFAULT_ERROR_MESSAGE} />}
      {silent && (
        <Text variant="label" color="textMuted">
          Nothing heard
        </Text>
      )}
    </View>
  );
}
