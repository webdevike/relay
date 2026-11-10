/**
 * Walkie-talkie in a composer: hold to talk, let go to send (to wherever the screen pointed the
 * dictation target). `useHoldToTalkGesture` makes any area holdable (a tap there does `onTap`),
 * `useWalkieOrb` keeps `ListeningOrb` (the edge glow) mounted from the hold until it has faded.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gesture, type ComposedGesture } from "react-native-gesture-handler";
import { impactHaptic, tapHaptic } from "@/lib/haptics";
import { dictationActor } from "./actor";
import { phaseOf } from "./machine";
import { useDictation } from "./useDictation";
import { HOLD_MS } from "./ComposerMic";

/** The finger may wander this far (pt) while it holds; talking hands move. */
const HOLD_SLOP = 2000;

export interface HoldToTalk {
  enabled: boolean;
  /** A short tap on the area (focus the field). */
  onTap: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
}

/** Hold (HOLD_MS) to start listening, lift to send; a tap is `onTap`. */
export function useHoldToTalkGesture({ enabled, onTap, onHoldStart, onHoldEnd }: HoldToTalk): ComposedGesture {
  const handlers = useRef({ onTap, onHoldStart, onHoldEnd });
  handlers.current = { onTap, onHoldStart, onHoldEnd };
  const held = useRef(false);
  return useMemo(() => {
    const hold = Gesture.LongPress()
      .minDuration(HOLD_MS)
      .maxDistance(HOLD_SLOP)
      .enabled(enabled)
      .runOnJS(true)
      .onStart(() => {
        const phase = phaseOf(dictationActor.getSnapshot());
        if (phase !== "idle" && phase !== "error" && phase !== "permission_denied") return;
        impactHaptic("medium");
        held.current = true;
        dictationActor.send({ type: "pressStart" });
        handlers.current.onHoldStart();
      })
      .onFinalize(() => {
        if (!held.current) return;
        held.current = false;
        if (phaseOf(dictationActor.getSnapshot()) === "listening") tapHaptic();
        dictationActor.send({ type: "release" });
        handlers.current.onHoldEnd();
      });
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (success) handlers.current.onTap();
      });
    return Gesture.Exclusive(hold, tap);
  }, [enabled]);
}

/**
 * Whether the screen should mount `ListeningOrb`: from `start` (a hold began) until the glow it
 * shows has faded out again, so a tap that dictates into the field never flashes it.
 */
export function useWalkieOrb(): { shown: boolean; start: () => void } {
  const { orb } = useDictation();
  const [shown, setShown] = useState(false);
  const seen = useRef(false);
  useEffect(() => {
    if (!shown) return;
    if (orb !== "hidden") seen.current = true;
    else if (seen.current) {
      seen.current = false;
      setShown(false);
    }
  }, [orb, shown]);
  const start = useCallback(() => {
    setShown(true);
  }, []);
  return { shown, start };
}
