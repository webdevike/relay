import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
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
import { impactHaptic, notifyHaptic, tapHaptic } from "@/lib/haptics";
import { useConnectionStore } from "@/state/connection";
import { useSpeechRecognitionEvent } from "expo-speech-recognition";
import { MicGlyph, type MicGlyphMode } from "./MicGlyph";
import { micLevel, sendLift } from "./signals";
import { dictationActor } from "./actor";
import { useDictation, openDictationSettings } from "./useDictation";
import { phaseOf, type DictationPhase } from "./machine";

const DEFAULT_SIZE = 40;
const CHIP_WIDTH = 220;
/** Finger travel (pt) up from the button that submits the dictation (insert + Return). */
const SEND_SWIPE_DISTANCE = 56;

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
export interface DictationButtonProps {
  size?: number;
  backgroundColor?: string;
}

export function DictationButton({ size: BUTTON_SIZE = DEFAULT_SIZE, backgroundColor = colors.surfaceRaised }: DictationButtonProps = {}) {
  const connected = useConnectionStore((state) => state.status === "connected");
  const state = useDictation();
  const ring = useSharedValue(1);
  const level = micLevel;
  useSpeechRecognitionEvent("volumechange", (event) => {
    // iOS reports roughly -2..10; below 0 is inaudible.
    const normalized = Math.min(1, Math.max(0, event.value / 8));
    level.value = withTiming(normalized, { duration: 70 });
  });
  useEffect(() => {
    if (state.phase === "sent") notifyHaptic("success");
    if (state.phase !== "listening") level.value = withTiming(0, { duration: motion.duration.fast });
  }, [state.phase, level]);

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

  // Leaving the screen mid-dictation aborts the recognizer (the actor outlives this component).
  useEffect(
    () => () => {
      dictationActor.send({ type: "reset" });
    },
    [],
  );

  const ringStyle = useAnimatedStyle(() => ({ transform: [{ scale: ring.value }] }));

  const glyphMode: MicGlyphMode =
    state.phase === "sent" ? "check" : state.phase === "listening" || state.phase === "finishing" || state.phase === "sending" ? "wave" : "mic";
  // The gesture object is created once so RNGH never swaps handlers mid-touch (which drops the
  // in-flight touch's finalize); the statechart decides what each event means in the current phase.
  const armed = useSharedValue(false);
  const pressed = useSharedValue(false);

  const gesture = useMemo(() => {
    const onPressIn = (): void => {
      const phase = phaseOf(dictationActor.getSnapshot());
      if (phase === "listening") {
        // A stray press while already listening (e.g. after a lost release) ends it.
        dictationActor.send({ type: "release" });
        return;
      }
      if (phase !== "idle" && phase !== "error" && phase !== "permission_denied") return;
      sendLift.value = 0;
      impactHaptic("medium");
      dictationActor.send({ type: "pressStart" });
    };
    const onPressOut = (): void => {
      if (phaseOf(dictationActor.getSnapshot()) === "listening") tapHaptic();
      dictationActor.send({ type: "release" });
    };
    const submit = (): void => {
      if (phaseOf(dictationActor.getSnapshot()) !== "listening") return;
      impactHaptic("heavy");
      dictationActor.send({ type: "pressStop", submit: true });
    };
    return Gesture.Pan()
      .minDistance(0)
      .maxPointers(1)
      .onBegin(() => {
        pressed.value = true;
        scheduleOnRN(onPressIn);
      })
      .onUpdate((event) => {
        // The orb lifts with the finger; crossing the swipe distance submits immediately.
        const lift = Math.min(1, Math.max(0, -event.translationY / SEND_SWIPE_DISTANCE));
        if (!armed.value) sendLift.value = lift;
        if (lift >= 1 && !armed.value) {
          armed.value = true;
          scheduleOnRN(submit);
        }
      })
      .onFinalize(() => {
        pressed.value = false;
        armed.value = false;
        sendLift.value = withTiming(0, { duration: motion.duration.base });
        scheduleOnRN(onPressOut);
      });
  }, [armed, pressed]);

  const buttonStyle = useAnimatedStyle(() => ({ opacity: !connected ? 0.4 : pressed.value ? 0.85 : 1 }));

  const showPermissionChip = state.phase === "permission_denied";
  const showErrorChip = state.phase === "error";
  const showNothingHeardChip = state.phase === "idle" && state.nothingHeard;
  const chipVisible = showPermissionChip || showErrorChip || showNothingHeardChip;

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
        <GestureDetector gesture={gesture.enabled(connected)}>
          <Animated.View
            style={[
              {
                width: BUTTON_SIZE,
                height: BUTTON_SIZE,
                borderRadius: BUTTON_SIZE / 2,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor,
              },
              buttonStyle,
            ]}
          >
            <MicGlyph mode={glyphMode} size={BUTTON_SIZE} tintColor={tintFor[state.phase]} level={level} />
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}
