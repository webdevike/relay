import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { colors, motion, radii, spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { useConnectionStore } from "@/state/connection";
import { useDictation, openDictationSettings } from "./useDictation";
import type { DictationPhase } from "./machine";

const BUTTON_SIZE = 36;
const CHIP_WIDTH = 220;
const NOTHING_HEARD_HOLD_MS = 1500;
const ERROR_HOLD_MS = 2500;

const tintFor: Record<DictationPhase, string> = {
  idle: colors.text,
  requesting_permission: colors.textMuted,
  permission_denied: colors.danger,
  listening: colors.accent,
  finishing: colors.accent,
  sending: colors.accent,
  sent: colors.ok,
  error: colors.danger,
};

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

/** Hold-to-talk mic: press and hold to listen, release to send. Floating chip shows live text and failures. */
export function DictationButton() {
  const connected = useConnectionStore((state) => state.status === "connected");
  const dictation = useDictation();
  const { state, transcript } = dictation;
  const ring = useSharedValue(1);
  const [nothingHeardDismissed, setNothingHeardDismissed] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);

  useEffect(() => {
    if (state.phase === "listening") {
      ring.value = withRepeat(withTiming(1.15, { duration: 900, easing: Easing.out(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(ring);
      ring.value = withTiming(1, { duration: motion.duration.fast });
    }
    return () => {
      cancelAnimation(ring);
    };
  }, [state.phase, ring]);

  useEffect(() => {
    if (!state.nothingHeard) {
      setNothingHeardDismissed(false);
      return undefined;
    }
    const id = setTimeout(() => {
      setNothingHeardDismissed(true);
    }, NOTHING_HEARD_HOLD_MS);
    return () => {
      clearTimeout(id);
    };
  }, [state.nothingHeard]);

  useEffect(() => {
    if (state.phase !== "error") {
      setErrorDismissed(false);
      return undefined;
    }
    const id = setTimeout(() => {
      setErrorDismissed(true);
      dictation.cancel();
    }, ERROR_HOLD_MS);
    return () => {
      clearTimeout(id);
    };
  }, [state.phase]);

  const ringStyle = useAnimatedStyle(() => ({ transform: [{ scale: ring.value }] }));

  const icon: SFSymbol = state.phase === "sent" ? "checkmark" : "mic.fill";
  const interactive = connected && (state.phase === "idle" || state.phase === "listening" || state.phase === "error");

  const holding = useRef(false);
  const onPressIn = (): void => {
    if (state.phase === "error") {
      dictation.cancel();
      return;
    }
    if (state.phase !== "idle") return;
    holding.current = true;
    tapHaptic();
    dictation.start();
  };
  const onPressOut = (): void => {
    holding.current = false;
    if (state.phase === "listening") dictation.stop();
  };
  // Released during the permission prompt: stop as soon as listening actually begins.
  useEffect(() => {
    if (state.phase === "listening" && !holding.current) dictation.stop();
  }, [state.phase, dictation]);

  const showTranscriptChip = state.phase === "listening" || state.phase === "finishing" || state.phase === "sending";
  const showPermissionChip = state.phase === "permission_denied";
  const showErrorChip = state.phase === "error" && !errorDismissed;
  const showNothingHeardChip = state.phase === "idle" && state.nothingHeard && !nothingHeardDismissed;
  const chipVisible = showTranscriptChip || showPermissionChip || showErrorChip || showNothingHeardChip;

  return (
    <View style={{ alignItems: "center" }}>
      {chipVisible && (
        <View
          style={{
            position: "absolute",
            bottom: BUTTON_SIZE + spacing.md,
            width: CHIP_WIDTH,
            backgroundColor: colors.surfaceRaised,
            borderRadius: radii.md,
            padding: spacing.md,
            gap: spacing.sm,
          }}
        >
          {showTranscriptChip && (
            <>
              <Text variant="body" numberOfLines={2}>
                {transcript.length > 0 ? transcript : "Listening…"}
              </Text>
            </>
          )}
          {showPermissionChip && (
            <Banner
              tone="warn"
              message="Speech recognition access is off."
              actionLabel="Open Settings"
              onAction={openDictationSettings}
            />
          )}
          {showErrorChip && (
            <Banner tone="danger" message={errorMessage[state.errorCode ?? "internal"] ?? DEFAULT_ERROR_MESSAGE} />
          )}
          {showNothingHeardChip && (
            <Text variant="label" color="textMuted">
              Nothing heard
            </Text>
          )}
        </View>
      )}
      <View style={{ width: BUTTON_SIZE, height: BUTTON_SIZE, alignItems: "center", justifyContent: "center" }}>
        {state.phase === "listening" && (
          <Animated.View
            style={[
              {
                position: "absolute",
                width: BUTTON_SIZE,
                height: BUTTON_SIZE,
                borderRadius: BUTTON_SIZE / 2,
                borderWidth: 1.5,
                borderColor: colors.accent,
              },
              ringStyle,
            ]}
          />
        )}
        <Pressable
          disabled={!interactive}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          style={({ pressed }) => ({
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: BUTTON_SIZE / 2,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.surfaceRaised,
            opacity: !connected ? 0.4 : pressed ? 0.85 : 1,
          })}
        >
          <SymbolView name={icon} size={BUTTON_SIZE * 0.45} tintColor={tintFor[state.phase]} />
        </Pressable>
      </View>
      {!connected && (
        <Text variant="caption" color="textFaint" style={{ marginTop: spacing.xs }}>
          Offline
        </Text>
      )}
    </View>
  );
}
