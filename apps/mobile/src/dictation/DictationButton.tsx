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
  withDelay,
  withSequence,
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
import { VozDictation } from "../../modules/voz-dictation";
import { MicGlyph, type MicGlyphMode } from "./MicGlyph";
import { micLevel, sendLift, wheelConfirm, wheelDetent, wheelPosition } from "./signals";
import { WHEEL_STEP_RAD } from "./SkillWheel";
import { dictationActor } from "./actor";
import { useDictation, openDictationSettings } from "./useDictation";
import { phaseOf, type DictationPhase } from "./machine";
import type { AgentSkill, AgentSkillChoice } from "@relay/protocol";

const DEFAULT_SIZE = 40;
const CHIP_WIDTH = 220;
/** Finger travel (pt) up from the button that submits the dictation (or fires `onLift`). */
const SEND_SWIPE_DISTANCE = 56;
/** Finger travel (pt) left from the button that opens the skill wheel. */
const WHEEL_SWIPE_DISTANCE = 56;
/** Distance (pt) below the mic's center where the close target sits while the wheel is open. */
const CLOSE_DISTANCE = 112;
/** Finger within this distance (pt) of the close target shuts the wheel. */
const CLOSE_RADIUS = 36;
const CLOSE_SIZE = 44;
/** How long (ms) the wheel keeps turning on its own after a fast release, before the snap. */
const MOMENTUM_MS = 60;
/** A finger still for longer than this (ms) before lifting has no momentum. */
const MOMENTUM_STALE_MS = 80;
/** Detent tick decay (ms) and the confirmation bloom's fade (ms). */
const DETENT_MS = 140;
const CONFIRM_MS = 380;
/** The snap onto the picked entry: short, critically damped, no visible bounce; settles in about SNAP_MS. */
const SNAP_SPRING = { damping: 26, stiffness: 380, mass: 1, overshootClamping: true };
const SNAP_MS = 220;
/** Vertical finger speed (pt/ms) that counts as a flick rather than scrubbing along the wheel. */
const FLICK_VELOCITY = 0.9;
/** Travel (pt) at flick speed that moves between rings: up into an entry's choices, down back out. */
const FLICK_DISTANCE = 44;

type WheelStage = "closed" | "open";
type WheelRing = "top" | "choices";

/** Index into the list for an unbounded wheel position. */
function wrapIndex(position: number, count: number): number {
  "worklet";
  return ((position % count) + count) % count;
}

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
 * Hold-to-talk mic: press and hold to listen, release to send. The flick up submits (insert plus
 * Return) unless the screen gives `onLift`, which then owns the flick: what was heard is dropped, the
 * orb launches, and `onLift` runs. With `skills`, a swipe left while holding opens the skill wheel:
 * scrub around the mic to bring an entry under the marker, lift to lock it in; the next hold dictates
 * with it armed. Floating chip shows failures; the armed skill is the inbox's notch.
 */
export interface DictationButtonProps {
  size?: number;
  backgroundColor?: string;
  /** Skills the wheel offers; omit (trackpad) and the swipe left does nothing. */
  skills?: AgentSkill[];
  /** Takes over the flick up: the inbox starts a session with it. */
  onLift?: () => void;
}

export function DictationButton({
  size: BUTTON_SIZE = DEFAULT_SIZE,
  backgroundColor = colors.surfaceRaised,
  skills,
  onLift,
}: DictationButtonProps = {}) {
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
    // Voz reports its own 0..1 loudness while it records.
    const subscription = VozDictation.addListener("level", (event) => {
      level.value = withTiming(event.value, { duration: 70 });
    });
    return () => {
      subscription.remove();
    };
  }, [level]);
  useEffect(() => {
    if (state.phase === "sent") notifyHaptic("success");
    if (state.phase !== "listening")
      level.value = withTiming(0, { duration: motion.duration.fast });
  }, [state.phase, level]);

  useEffect(() => {
    if (state.phase === "listening") {
      ring.value = withRepeat(
        withTiming(1.15, { duration: 900, easing: Easing.out(Easing.ease) }),
        -1,
        true,
      );
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
    state.phase === "sent"
      ? "check"
      : state.phase === "listening" || state.phase === "finishing" || state.phase === "sending"
        ? "wave"
        : "mic";
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
  const topCount = useSharedValue(skills?.length ?? 0);
  const choiceCounts = useSharedValue<number[]>([]);
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const onLiftRef = useRef(onLift);
  onLiftRef.current = onLift;
  useEffect(() => {
    enabled.value = connected;
    const count = skills?.length ?? 0;
    topCount.value = count;
    skillCount.value = count;
    choiceCounts.value = skills?.map((skill) => skill.choices?.length ?? 0) ?? [];
  }, [connected, enabled, skills, skillCount, topCount, choiceCounts]);
  // Wheel geometry lives on the UI thread: the finger's angle around the press point turns the
  // wheel 1:1, each entry crossing the marker ticks, a fast flick up opens the centered entry's
  // choices as a second ring (flick down comes back), and the lift carries a little momentum
  // before the wheel springs onto the nearest entry and arms it.
  const wheel = useSharedValue<WheelStage>("closed");
  const wheelRing = useSharedValue<WheelRing>("top");
  const parentIndex = useSharedValue(0);
  const fingerAngle = useSharedValue(0);
  const snapped = useSharedValue(0);
  const angularVelocity = useSharedValue(0);
  const lastAt = useSharedValue(0);
  const lastY = useSharedValue(0);
  const flickTravel = useSharedValue(0);
  const flickIndex = useSharedValue(0);
  // Where the wheel opens: on the armed skill (or the entry whose choice is armed), so reopening shows what is set.
  const armedIndex = useSharedValue(0);
  useEffect(() => {
    const index =
      skills?.findIndex(
        (skill) =>
          skill.command === state.skill ||
          skill.choices?.some((choice) => choice.command === state.skill) === true,
      ) ?? -1;
    armedIndex.value = Math.max(0, index);
  }, [skills, state.skill, armedIndex]);

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
    /** The flick up: the screen's `onLift` if it gave one (dropping what was heard), else submit. */
    const flickUp = (): void => {
      const lift = onLiftRef.current;
      if (lift === undefined) {
        if (phaseOf(dictationActor.getSnapshot()) !== "listening") return;
        impactHaptic("heavy");
        dictationActor.send({ type: "pressStop", submit: true });
        return;
      }
      impactHaptic("heavy");
      dictationActor.send({ type: "launch" });
      lift();
    };
    const openWheel = (): void => {
      debug("dictation", "wheel open", phaseOf(dictationActor.getSnapshot()));
      impactHaptic("medium");
      dictationActor.send({ type: "wheelOpen" });
    };
    /** The entry at `index` on the ring the chart says is showing. */
    const entryAt = (index: number): AgentSkillChoice | undefined => {
      const parent = dictationActor.getSnapshot().context.wheelParent;
      const top = skillsRef.current;
      if (parent === null) return top?.[index];
      return top?.find((skill) => skill.command === parent)?.choices?.[index];
    };
    const pick = (index: number): void => {
      const entry = entryAt(index);
      debug("dictation", "wheel pick", index, entry?.command ?? "none");
      if (entry === undefined) return;
      // An entry that only holds choices is a folder, not a command: lifting on it picks nothing.
      if (!entry.takesText && "choices" in entry) return;
      dictationActor.send({ type: "wheelSelect", skill: entry.command, submit: !entry.takesText });
      setTimeout(() => {
        impactHaptic("heavy");
      }, SNAP_MS);
    };
    const descend = (index: number): void => {
      const parent = skillsRef.current?.[index];
      debug("dictation", "wheel descend", index, parent?.command ?? "none");
      if (parent === undefined) return;
      impactHaptic("medium");
      dictationActor.send({ type: "wheelDescend", parent: parent.command });
    };
    const ascend = (): void => {
      debug("dictation", "wheel ascend");
      tapHaptic();
      dictationActor.send({ type: "wheelAscend" });
    };
    const closeWheel = (): void => {
      debug("dictation", "wheel close", phaseOf(dictationActor.getSnapshot()));
      tapHaptic();
      dictationActor.send({ type: "wheelClose" });
    };
    // Lift on the wheel: a touch of momentum, then a spring onto the nearest entry, then the
    // confirmation bloom and the strong haptic once it has locked (timed to the spring's settle).
    const lockWheel = (): void => {
      "worklet";
      const stale = Date.now() - lastAt.value > MOMENTUM_STALE_MS;
      const carried = stale ? 0 : angularVelocity.value * MOMENTUM_MS;
      const here = Math.round(wheelPosition.value);
      const target = Math.max(
        here - 1,
        Math.min(here + 1, Math.round(wheelPosition.value + carried)),
      );
      wheelPosition.value = withSpring(target, SNAP_SPRING);
      wheelConfirm.value = withDelay(
        SNAP_MS,
        withSequence(withTiming(1, { duration: 0 }), withTiming(0, { duration: CONFIRM_MS })),
      );
      scheduleOnRN(pick, wrapIndex(target, skillCount.value));
    };
    const finish = (reason: string): void => {
      "worklet";
      if (!pressed.value) return;
      pressed.value = false;
      armed.value = false;
      if (wheel.value === "open") lockWheel();
      wheel.value = "closed";
      sendLift.value = withTiming(0, { duration: motion.duration.base });
      scheduleOnRN(onPressOut, reason);
    };
    /** Fast vertical runs move between rings: up opens the centered entry's choices, down closes them. */
    const flick = (y: number, index: number, dt: number): void => {
      "worklet";
      const rise = lastY.value - y;
      lastY.value = y;
      if (Math.abs(rise) / dt < FLICK_VELOCITY) {
        flickTravel.value = 0;
        return;
      }
      // A run starts on the first fast sample; the entry then is the one the run means.
      if (flickTravel.value === 0 || Math.sign(rise) !== Math.sign(flickTravel.value)) {
        flickTravel.value = 0;
        flickIndex.value = index;
      }
      flickTravel.value += rise;
      if (flickTravel.value >= FLICK_DISTANCE && wheelRing.value === "top") {
        const parent = wrapIndex(flickIndex.value, topCount.value);
        const count = choiceCounts.value[parent] ?? 0;
        flickTravel.value = 0;
        if (count === 0) return;
        wheelRing.value = "choices";
        parentIndex.value = parent;
        skillCount.value = count;
        wheelPosition.value = 0;
        snapped.value = 0;
        scheduleOnRN(descend, parent);
      } else if (flickTravel.value <= -FLICK_DISTANCE && wheelRing.value === "choices") {
        flickTravel.value = 0;
        wheelRing.value = "top";
        skillCount.value = topCount.value;
        wheelPosition.value = parentIndex.value;
        snapped.value = parentIndex.value;
        scheduleOnRN(ascend);
      }
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
      // Screen y points down, so a growing angle is clockwise: forward through the list. The
      // position is unbounded; the list wraps around it.
      const step = delta / WHEEL_STEP_RAD;
      const next = wheelPosition.value + step;
      wheelPosition.value = next;
      const now = Date.now();
      const dt = Math.max(1, now - lastAt.value);
      lastAt.value = now;
      angularVelocity.value = angularVelocity.value * 0.5 + (step / dt) * 0.5;
      const index = Math.round(next);
      if (index !== snapped.value) {
        snapped.value = index;
        wheelDetent.value = 1;
        wheelDetent.value = withTiming(0, { duration: DETENT_MS });
        scheduleOnRN(selectHaptic);
      }
      flick(y, index, dt);
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
        if (armed.value) return;
        // A sideways run to the left opens the wheel; an upward run lifts the orb and submits.
        if (topCount.value > 0 && -dx >= WHEEL_SWIPE_DISTANCE && Math.abs(dy) < -dx) {
          wheel.value = "open";
          wheelRing.value = "top";
          skillCount.value = topCount.value;
          fingerAngle.value = Math.atan2(dy, dx);
          cancelAnimation(wheelPosition);
          wheelPosition.value = armedIndex.value;
          snapped.value = armedIndex.value;
          angularVelocity.value = 0;
          lastAt.value = Date.now();
          lastY.value = touch.absoluteY;
          flickTravel.value = 0;
          sendLift.value = 0;
          scheduleOnRN(openWheel);
          return;
        }
        // The orb lifts with the finger; crossing the swipe distance submits (or launches) immediately.
        const lift = Math.min(1, Math.max(0, -dy / SEND_SWIPE_DISTANCE));
        sendLift.value = lift;
        if (lift >= 1) {
          armed.value = true;
          scheduleOnRN(flickUp);
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
  }, [
    armed,
    pressed,
    startX,
    startY,
    enabled,
    skillCount,
    topCount,
    choiceCounts,
    wheel,
    wheelRing,
    parentIndex,
    fingerAngle,
    snapped,
    angularVelocity,
    lastAt,
    lastY,
    flickTravel,
    flickIndex,
    armedIndex,
  ]);

  const buttonStyle = useAnimatedStyle(() => ({
    opacity: !connected ? 0.4 : pressed.value ? 0.85 : 1,
  }));

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
            <Banner
              tone="danger"
              message={errorMessage[state.errorCode ?? "internal"] ?? DEFAULT_ERROR_MESSAGE}
            />
          )}
          {showNothingHeardChip && (
            <Text variant="label" color="textMuted">
              Nothing heard
            </Text>
          )}
        </View>
      )}
      <View
        style={{
          width: BUTTON_SIZE,
          height: BUTTON_SIZE,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
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
            <MicGlyph
              mode={glyphMode}
              size={BUTTON_SIZE}
              tintColor={tintFor[state.phase]}
              level={level}
            />
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
