import { Linking } from "react-native";
import { useSelector } from "@xstate/react";
import { dictationActor } from "./actor";
import { orbOf, phaseOf, type DictationContext, type DictationPhase, type OrbState } from "./machine";

export interface DictationSnapshot extends DictationContext {
  phase: DictationPhase;
  orb: OrbState;
}

/** Re-renders on every dictation transition; the phase is derived from the statechart value. */
export function useDictation(): DictationSnapshot {
  return useSelector(dictationActor, (snapshot) => ({ phase: phaseOf(snapshot), orb: orbOf(snapshot), ...snapshot.context }), sameSnapshot);
}

function sameSnapshot(a: DictationSnapshot, b: DictationSnapshot): boolean {
  return (
    a.phase === b.phase &&
    a.orb === b.orb &&
    a.transcript === b.transcript &&
    a.nothingHeard === b.nothingHeard &&
    a.errorCode === b.errorCode &&
    a.submit === b.submit &&
    a.skill === b.skill
  );
}

export function openDictationSettings(): void {
  void Linking.openSettings();
}
