import { useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { colors, motion, radii, spacing } from "@/theme";
import { impactHaptic, notifyHaptic, selectHaptic, tapHaptic } from "@/lib/haptics";
import { useConnectionStore } from "@/state/connection";
import { debug } from "@/connection/log";
import { useSpeechRecognitionEvent } from "expo-speech-recognition";
import { MicGlyph, type MicGlyphMode } from "./MicGlyph";
import { micLevel, sendLift, wheelPosition, wheelSnap } from "./signals";
import { WHEEL_STEP_RAD } from "./SkillWheel";
import { dictationActor } from "./actor";
import { useDictation, openDictationSettings } from "./useDictation";
import { phaseOf, type DictationPhase } from "./machine";
import type { AgentSkill } from "@relay/protocol";

const DEFAULT_SIZE = 40;
const CHIP_WIDTH = 220;
/** Finger travel (pt) up from the button that submits the dictation (insert + Return). */
const SEND_SWIPE_DISTANCE = 56;
/** Finger travel (pt) left from the button that opens the skill wheel. */
const WHEEL_SWIPE_DISTANCE = 56;
/** Distance (pt) below the mic's center where the close target sits while the wheel is open. */
const CLOSE_DISTANCE = 112;
/** Finger within this distance (pt) of the close target shuts the wheel. */
const CLOSE_RADIUS = 36;
const CLOSE_SIZE = 44;
/** Quick, slightly bouncy settle into the slot on each snap. */
const SNAP_SPRING = { damping: 18, stiffness: 320, mass: 0.6 };
/** Upward finger speed (pt/ms) that counts as a flick rather than scrubbing along the wheel. */
const FLICK_VELOCITY = 0.9;
/** Upward travel (pt) at flick speed that picks the snapped skill. */
const FLICK_DISTANCE = 44;
/** Finger within this distance (pt) of the press point after a pick brings listening back. */
const RETURN_RADIUS = 30;

type WheelStage = "closed" | "open" | "chosen";

const tintFor: Record<DictationPhase, string> = {
  idle: colors.text,
  requesting_permission: colors.textMuted,
  permission_denied: colors.danger,
  listening: colors.accent,
  choosing: colors.textMuted,
  chosen: colors.accent,
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

/**
 * Hold-to-talk mic: press and hold to listen, release to put the text in the input, flick up to
 * send. With `skills`, a swipe left while holding opens the skill wheel: scrub around the mic to
 * snap a skill into the top slot, flick up to pick it, come back to the mic to dictate with it.
 * Floating chip shows failures and the picked skill.
 */
export interface DictationButtonProps {
  size?: number;
  backgroundColor?: string;
  /** Skills the wheel offers; omit (trackpad) and the swipe left does nothing. */
  skills?: AgentSkill[];
}

export function DictationButton({ size: BUTTON_SIZE = DEFAULT_SIZE, backgroundColor = colors.surfaceRaised, skills }: DictationButtonProps = {}) {
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
  // A Manual gesture fed by raw touch events: the release comes from onTouchesUp/Cancelled, not
  // from the recognizer's own state machine, so a competing recognizer (the trackpad surface
  // underneath, the navigator's edge swipe) can never swallow the finger lifting. The gesture is
  // built once and never reconfigured per render: reconfiguring a handler mid-touch is what used
  // to drop finalize. `connected` and the skill count are mirrored into shared values for the
  // same reason; the skill list itself is read through a ref when a pick lands on the JS thread.
  const armed = useSharedValue(false);
  const pressed = useSharedValue(false);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const enabled = useSharedValue(connected);
  const skillCount = useSharedValue(skills?.length ?? 0);
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  useEffect(() => {
    enabled.value = connected;
    skillCount.value = skills?.length ?? 0;
  }, [connected, enabled, skills, skillCount]);
  // Wheel geometry lives on the UI thread: the finger's angle around the press point turns the
  // wheel, the snapped index ticks, and a fast upward run picks the skill that was snapped when
  // the run began (the run itself would otherwise nudge the wheel one notch first).
  const wheel = useSharedValue<WheelStage>("closed");
  const fingerAngle = useSharedValue(0);
  const snapped = useSharedValue(0);
  const lastY = useSharedValue(0);
  const lastAt = useSharedValue(0);
  const flickTravel = useSharedValue(0);
  const flickIndex = useSharedValue(0);

  const gesture = useMemo(() => {
    const onPressIn = (): void => {
      // The chart decides what a press means here (start, recover a lost release, or nothing).
      const phase = phaseOf(dictationActor.getSnapshot());
      debug("dictation", "press in", phase);
      if (phase === "idle" || phase === "error" || phase === "permission_denied") {
        sendLift.value = 0;
        impactHaptic("medium");
      }
      dictationActor.send({ type: "pressStart" });
    };
    const onPressOut = (reason: string): void => {
      const phase = phaseOf(dictationActor.getSnapshot());
      debug("dictation", "press out", reason, phase);
      if (phase === "listening") tapHaptic();
      dictationActor.send({ type: "release" });
    };
    const submit = (): void => {
      if (phaseOf(dictationActor.getSnapshot()) !== "listening") return;
      impactHaptic("heavy");
      dictationActor.send({ type: "pressStop", submit: true });
    };
    const openWheel = (): void => {
      debug("dictation", "wheel open", phaseOf(dictationActor.getSnapshot()));
      impactHaptic("medium");
      dictationActor.send({ type: "wheelOpen" });
    };
    const pick = (index: number): void => {
      const skill = skillsRef.current?.[index];
      debug("dictation", "wheel pick", index, skill?.command ?? "none");
      if (skill === undefined) return;
      impactHaptic("heavy");
      dictationActor.send({ type: "wheelSelect", skill: skill.command });
    };
    const resume = (): void => {
      debug("dictation", "wheel resume", phaseOf(dictationActor.getSnapshot()));
      impactHaptic("medium");
      dictationActor.send({ type: "resume" });
    };
    const closeWheel = (): void => {
      debug("dictation", "wheel close", phaseOf(dictationActor.getSnapshot()));
      tapHaptic();
      dictationActor.send({ type: "wheelClose" });
    };
    const finish = (reason: string): void => {
      "worklet";
      if (!pressed.value) return;
      pressed.value = false;
      armed.value = false;
      wheel.value = "closed";
      sendLift.value = withTiming(0, { duration: motion.duration.base });
      scheduleOnRN(onPressOut, reason);
    };
    const turnWheel = (dx: number, dy: number, y: number): void => {
      "worklet";
      // Sliding down onto the x shuts the wheel; the rest of this touch does nothing.
      const cx = dx;
      const cy = dy - CLOSE_DISTANCE;
      if (cx * cx + cy * cy <= CLOSE_RADIUS * CLOSE_RADIUS) {
        wheel.value = "closed";
        armed.value = true;
        scheduleOnRN(closeWheel);
        return;
      }
      const angle = Math.atan2(dy, dx);
      let delta = angle - fingerAngle.value;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      else if (delta < -Math.PI) delta += 2 * Math.PI;
      fingerAngle.value = angle;
      // Screen y points down, so a growing angle is clockwise: forward through the list.
      const last = skillCount.value - 1;
      const next = Math.min(last, Math.max(0, wheelPosition.value + delta / WHEEL_STEP_RAD));
      wheelPosition.value = next;
      const index = Math.round(next);
      if (index !== snapped.value) {
        snapped.value = index;
        wheelSnap.value = withSpring(index, SNAP_SPRING);
        scheduleOnRN(selectHaptic);
      }
      // Flick: consecutive fast upward samples. Slow scrubbing resets the run.
      const now = Date.now();
      const dt = Math.max(1, now - lastAt.value);
      const rise = lastY.value - y;
      lastY.value = y;
      lastAt.value = now;
      if (rise / dt < FLICK_VELOCITY) {
        flickTravel.value = 0;
        return;
      }
      if (flickTravel.value === 0) flickIndex.value = index;
      flickTravel.value += rise;
      if (flickTravel.value >= FLICK_DISTANCE) {
        wheel.value = "chosen";
        scheduleOnRN(pick, flickIndex.value);
      }
    };
    return Gesture.Manual()
      .onTouchesDown((event, manager) => {
        if (pressed.value || !enabled.value) return;
        const touch = event.allTouches[0];
        if (touch === undefined) return;
        pressed.value = true;
        startX.value = touch.absoluteX;
        startY.value = touch.absoluteY;
        manager.activate();
        scheduleOnRN(onPressIn);
      })
      .onTouchesMove((event) => {
        if (!pressed.value) return;
        const touch = event.allTouches[0];
        if (touch === undefined) return;
        const dx = touch.absoluteX - startX.value;
        const dy = touch.absoluteY - startY.value;
        if (wheel.value === "open") {
          turnWheel(dx, dy, touch.absoluteY);
          return;
        }
        if (wheel.value === "chosen") {
          // Back on the mic: listen again with the skill armed.
          if (dx * dx + dy * dy <= RETURN_RADIUS * RETURN_RADIUS) {
            wheel.value = "closed";
            scheduleOnRN(resume);
          }
          return;
        }
        if (armed.value) return;
        // A sideways run to the left opens the wheel; an upward run lifts the orb and submits.
        if (skillCount.value > 0 && -dx >= WHEEL_SWIPE_DISTANCE && Math.abs(dy) < -dx) {
          wheel.value = "open";
          fingerAngle.value = Math.atan2(dy, dx);
          wheelPosition.value = 0;
          wheelSnap.value = 0;
          snapped.value = 0;
          lastY.value = touch.absoluteY;
          lastAt.value = Date.now();
          flickTravel.value = 0;
          sendLift.value = 0;
          scheduleOnRN(openWheel);
          return;
        }
        // The orb lifts with the finger; crossing the swipe distance submits immediately.
        const lift = Math.min(1, Math.max(0, -dy / SEND_SWIPE_DISTANCE));
        sendLift.value = lift;
        if (lift >= 1) {
          armed.value = true;
          scheduleOnRN(submit);
        }
      })
      .onTouchesUp((event, manager) => {
        if (event.numberOfTouches > 0) return;
        finish("up");
        manager.end();
      })
      .onTouchesCancelled((_event, manager) => {
        finish("cancelled");
        manager.fail();
      })
      .onFinalize(() => {
        finish("finalize");
      });
  }, [armed, pressed, startX, startY, enabled, skillCount, wheel, fingerAngle, snapped, lastY, lastAt, flickTravel, flickIndex]);

  const buttonStyle = useAnimatedStyle(() => ({ opacity: !connected ? 0.4 : pressed.value ? 0.85 : 1 }));

  const showPermissionChip = state.phase === "permission_denied";
  const showErrorChip = state.phase === "error";
  const showNothingHeardChip = state.phase === "idle" && state.nothingHeard;
  // The armed skill rides above the mic from the pick until delivery; after a bare release it
  // lingers as the announcement of what was picked.
  const showSkillChip = state.skill !== null && !showErrorChip && !showPermissionChip && state.phase !== "choosing";
  const chipVisible = showPermissionChip || showErrorChip || showNothingHeardChip || showSkillChip;

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
          {showSkillChip && (
            <Text variant="label" color={state.phase === "idle" ? "textMuted" : "accent"}>
              {state.phase === "idle" ? `${state.skill ?? ""} selected` : (state.skill ?? "")}
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
      {state.phase === "choosing" && (
        <Animated.View
          pointerEvents="none"
          entering={FadeIn.duration(motion.duration.base)}
          exiting={FadeOut.duration(motion.duration.fast)}
          style={{
            position: "absolute",
            top: BUTTON_SIZE / 2 + CLOSE_DISTANCE - CLOSE_SIZE / 2,
            width: CLOSE_SIZE,
            height: CLOSE_SIZE,
            borderRadius: CLOSE_SIZE / 2,
            borderWidth: 1,
            borderColor: colors.hairline,
            backgroundColor: colors.surfaceRaised,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SymbolView name="xmark" size={18} tintColor={colors.textMuted} />
        </Animated.View>
      )}
    </View>
  );
}
