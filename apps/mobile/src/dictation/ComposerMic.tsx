import { useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { spacing, useColors } from "@/theme";
import { impactHaptic, tapHaptic } from "@/lib/haptics";
import { debug } from "@/connection/log";
import { Disc } from "@/ui/Disc";
import { MicGlyph } from "./MicGlyph";
import { micLevel } from "./signals";
import { dictationActor } from "./actor";
import { phaseOf } from "./machine";
import { useDictation } from "./useDictation";
import { DictationStatus } from "./DictationStatus";

/** A press longer than this is a hold (walkie-talkie); a shorter one is a tap (dictate into the field). */
export const HOLD_MS = 280;

export interface ComposerMicProps {
  size: number;
  backgroundColor: string;
  enabled: boolean;
  /** Short press: listening goes on after the finger lifts, into the composer's field. */
  onTap: () => void;
  /** The press became a hold: walkie-talkie, whatever is said goes out on release. */
  onHoldStart: () => void;
  /** The held finger lifted (or the touch was taken away): the words are on their way. */
  onHoldEnd: () => void;
}

/**
 * A composer's mic: tap to dictate into the field, hold to talk and send on release. Listening
 * starts on touch down either way, so a hold loses no words; the release decides which it was.
 * A Manual gesture fed by raw touches (as `DictationButton`), so nothing underneath can swallow
 * the finger lifting. The composer feeds `micLevel` (`useMicLevel`) and resets the dictation when
 * it leaves, since this button hides while a tap dictation runs.
 */
export function ComposerMic({ size, backgroundColor, enabled, onTap, onHoldStart, onHoldEnd }: ComposerMicProps) {
  const colors = useColors();
  const { phase } = useDictation();
  const pressed = useSharedValue(false);
  const live = useSharedValue(enabled);
  useEffect(() => {
    live.value = enabled;
  }, [enabled, live]);
  const handlers = useRef({ onTap, onHoldStart, onHoldEnd });
  handlers.current = { onTap, onHoldStart, onHoldEnd };
  const holding = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // This press started a dictation (one landing mid-send starts nothing, and its release means nothing).
  const started = useRef(false);

  // The mic hides while a tap dictation runs (its stop and send take over), so it never resets the
  // dictation on unmount: the screen that owns the composer does.
  useEffect(
    () => () => {
      clearTimeout(holdTimer.current);
    },
    [],
  );

  const gesture = useMemo(() => {
    const pressIn = (): void => {
      const now = phaseOf(dictationActor.getSnapshot());
      debug("dictation", "composer mic in", now);
      if (now !== "idle" && now !== "error" && now !== "permission_denied") return;
      impactHaptic("medium");
      started.current = true;
      holding.current = false;
      dictationActor.send({ type: "pressStart" });
      holdTimer.current = setTimeout(() => {
        holding.current = true;
        handlers.current.onHoldStart();
      }, HOLD_MS);
    };
    const pressOut = (reason: string): void => {
      clearTimeout(holdTimer.current);
      if (!started.current) return;
      started.current = false;
      const now = phaseOf(dictationActor.getSnapshot());
      debug("dictation", "composer mic out", reason, now, holding.current ? "hold" : "tap");
      if (holding.current || reason !== "up") {
        holding.current = false;
        if (now === "listening") tapHaptic();
        dictationActor.send({ type: "release" });
        handlers.current.onHoldEnd();
        return;
      }
      handlers.current.onTap();
    };
    const finish = (reason: string): void => {
      "worklet";
      if (!pressed.value) return;
      pressed.value = false;
      scheduleOnRN(pressOut, reason);
    };
    return Gesture.Manual()
      .onTouchesDown((_event, manager) => {
        if (pressed.value || !live.value) return;
        pressed.value = true;
        manager.activate();
        scheduleOnRN(pressIn);
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
  }, [pressed, live]);

  const style = useAnimatedStyle(() => ({ opacity: !live.value ? 0.4 : pressed.value ? 0.8 : 1 }));
  const heard = phase === "listening" || phase === "finishing";
  return (
    <View style={{ alignItems: "center" }}>
      <DictationStatus bottom={size + spacing.md} />
      <GestureDetector gesture={gesture}>
        <Animated.View
          accessible
          accessibilityRole="button"
          accessibilityLabel="Dictate"
          accessibilityHint="Tap to dictate into the message, or hold to talk and send when you let go"
          style={[{ width: size, height: size, alignItems: "center", justifyContent: "center" }, style]}
        >
          <Disc size={size} color={backgroundColor} />
          <MicGlyph mode={heard ? "wave" : "mic"} size={size} tintColor={colors.text} level={micLevel} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
