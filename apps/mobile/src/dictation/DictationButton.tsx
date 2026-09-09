import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
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
import { micLevel } from "./signals";
import { useDictation, openDictationSettings } from "./useDictation";
import type { DictationPhase } from "./machine";

const DEFAULT_SIZE = 40;
const CHIP_WIDTH = 220;
const NOTHING_HEARD_HOLD_MS = 1500;
const ERROR_HOLD_MS = 2500;
/** Finger travel (pt) up from the button that arms the send gesture. */
const SEND_ARM_DISTANCE = 40;
/** Time (ms) the finger must stay in the armed zone before the transcript auto-submits. */
const SEND_HOLD_MS = 800;
const ARROW_SIZE = 32;

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
  const interactive = connected && (state.phase === "idle" || state.phase === "listening" || state.phase === "error");

  const holding = useRef(false);
  const submitted = useRef(false);
  const onPressIn = (): void => {
    if (state.phase === "error") {
      dictation.cancel();
      return;
    }
    if (state.phase !== "idle") return;
    holding.current = true;
    submitted.current = false;
    impactHaptic("medium");
    dictation.start();
  };
  const onPressOut = (): void => {
    holding.current = false;
    if (submitted.current) return;
    if (state.phase === "listening") {
      tapHaptic();
      dictation.stop();
    }
  };
  // Swipe up while holding: an arrow rises and fills; holding there for SEND_HOLD_MS submits
  // (insert + Return on the Mac) without waiting for the finger to lift.
  const armProgress = useSharedValue(0);
  const armed = useSharedValue(false);
  const submit = (): void => {
    if (submitted.current || state.phase !== "listening") return;
    submitted.current = true;
    impactHaptic("heavy");
    dictation.stop({ submit: true });
  };
  const pressed = useSharedValue(false);
  const gesture = Gesture.Pan()
    .enabled(interactive)
    .minDistance(0)
    .maxPointers(1)
    .onBegin(() => {
      pressed.value = true;
      scheduleOnRN(onPressIn);
    })
    .onUpdate((event) => {
      const shouldArm = event.translationY < -SEND_ARM_DISTANCE;
      if (shouldArm && !armed.value) {
        armed.value = true;
        armProgress.value = withTiming(1, { duration: SEND_HOLD_MS, easing: Easing.linear }, (finished) => {
          if (finished === true) scheduleOnRN(submit);
        });
      } else if (!shouldArm && armed.value) {
        armed.value = false;
        cancelAnimation(armProgress);
        armProgress.value = withTiming(0, { duration: motion.duration.fast });
      }
    })
    .onFinalize(() => {
      pressed.value = false;
      armed.value = false;
      cancelAnimation(armProgress);
      armProgress.value = withTiming(0, { duration: motion.duration.fast });
      scheduleOnRN(onPressOut);
    });
  const buttonStyle = useAnimatedStyle(() => ({ opacity: !connected ? 0.4 : pressed.value ? 0.85 : 1 }));
  // Arrow chip: appears as the finger lifts off the button, fills clockwise-ish via scale + tint.
  const arrowStyle = useAnimatedStyle(() => ({
    opacity: armed.value ? 1 : armProgress.value,
    transform: [{ translateY: -(BUTTON_SIZE / 2 + ARROW_SIZE / 2 + spacing.md) }, { scale: 0.8 + armProgress.value * 0.3 }],
  }));
  const arrowFillStyle = useAnimatedStyle(() => ({ height: `${armProgress.value * 100}%` }));

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
        <Animated.View pointerEvents="none" style={[{ position: "absolute", width: ARROW_SIZE, height: ARROW_SIZE }, arrowStyle]}>
          <View
            style={{
              width: ARROW_SIZE,
              height: ARROW_SIZE,
              borderRadius: ARROW_SIZE / 2,
              borderWidth: 1.5,
              borderColor: colors.accent,
              overflow: "hidden",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.surfaceRaised,
            }}
          >
            <Animated.View style={[{ position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: colors.accent }, arrowFillStyle]} />
            <SymbolView name="arrow.up" size={ARROW_SIZE * 0.5} tintColor={colors.text} weight="semibold" />
          </View>
        </Animated.View>
        <GestureDetector gesture={gesture}>
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
