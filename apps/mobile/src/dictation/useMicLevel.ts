import { useEffect } from "react";
import { withTiming } from "react-native-reanimated";
import { useSpeechRecognitionEvent } from "expo-speech-recognition";
import { motion } from "@/theme";
import { notifyHaptic } from "@/lib/haptics";
import { VozDictation } from "../../modules/voz-dictation";
import { micLevel } from "./signals";
import type { DictationPhase } from "./machine";

/**
 * Feeds `micLevel` from whichever recognizer is listening (Apple's volume events, Voz's own
 * loudness) and lets it fall to 0 once the phase leaves `listening`; buzzes on a delivered send.
 * Mounted by every mic control, so the orb and the level dots move with the voice.
 */
export function useMicLevel(phase: DictationPhase): void {
  useSpeechRecognitionEvent("volumechange", (event) => {
    // iOS reports roughly -2..10; below 0 is inaudible.
    const normalized = Math.min(1, Math.max(0, event.value / 8));
    micLevel.value = withTiming(normalized, { duration: 70 });
  });
  useEffect(() => {
    // Voz reports its own 0..1 loudness while it records.
    const subscription = VozDictation.addListener("level", (event) => {
      micLevel.value = withTiming(event.value, { duration: 70 });
    });
    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (phase === "sent") notifyHaptic("success");
    if (phase !== "listening") micLevel.value = withTiming(0, { duration: motion.duration.fast });
  }, [phase]);
}
