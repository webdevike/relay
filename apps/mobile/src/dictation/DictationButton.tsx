import { useEffect, useMemo, useRef, useState } from "react";
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
import { micLevel, sendLift, useDictationStore } from "./signals";
import { useDictation, openDictationSettings } from "./useDictation";
import type { DictationPhase } from "./machine";

const DEFAULT_SIZE = 40;
const CHIP_WIDTH = 220;
const NOTHING_HEARD_HOLD_MS = 1500;
const ERROR_HOLD_MS = 2500;
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
  const dictation = useDictation();
  const { state } = dictation;
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

  const glyphMode: MicGlyphMode =
    state.phase === "sent" ? "check" : state.phase === "listening" || state.phase === "finishing" || state.phase === "sending" ? "wave" : "mic";
  // Live handles for the gesture: the gesture object is created once (below) so RNGH never swaps
  // handlers mid-touch, which drops the in-flight touch's finalize. Everything it needs to read
  // at event time goes through refs.
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  const holding = useRef(false);
  const submitted = useRef(false);

  const armed = useSharedValue(false);
  const pressed = useSharedValue(false);

  const gesture = useMemo(() => {
    const onPressIn = (): void => {
      const phase = phaseRef.current;
      if (phase === "error") {
        dictationRef.current.cancel();
        return;
      }
      if (phase === "listening") {
        // A stray press while already listening (e.g. after a lost release) ends it.
        dictationRef.current.stop();
        return;
      }
      if (phase !== "idle") return;
      holding.current = true;
      submitted.current = false;
      impactHaptic("medium");
      dictationRef.current.start();
    };
    const onPressOut = (): void => {
      holding.current = false;
      if (submitted.current) {
        useDictationStore.getState().launch();
        return;
      }
      if (phaseRef.current === "listening") tapHaptic();
      dictationRef.current.stop(); // no-op unless listening
    };
    const submit = (): void => {
      if (submitted.current || phaseRef.current !== "listening") return;
      submitted.current = true;
      impactHaptic("heavy");
      dictationRef.current.stop({ submit: true });
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
        const wasArmed = armed.value;
        armed.value = false;
        if (!wasArmed) sendLift.value = withTiming(0, { duration: motion.duration.base });
        scheduleOnRN(onPressOut);
      });
  }, [armed, pressed]);

  const buttonStyle = useAnimatedStyle(() => ({ opacity: !connected ? 0.4 : pressed.value ? 0.85 : 1 }));

  const showPermissionChip = state.phase === "permission_denied";
  const showErrorChip = state.phase === "error" && !errorDismissed;
  const showNothingHeardChip = state.phase === "idle" && state.nothingHeard && !nothingHeardDismissed;
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
