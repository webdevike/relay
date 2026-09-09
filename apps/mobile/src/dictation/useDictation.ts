import { Linking } from "react-native";
import { useSelector } from "@xstate/react";
import { dictationActor } from "./actor";
import { phaseOf, type DictationContext, type DictationPhase } from "./machine";

export interface DictationSnapshot extends DictationContext {
  phase: DictationPhase;
}

/** Re-renders on every dictation transition; the phase is derived from the statechart value. */
export function useDictation(): DictationSnapshot {
  return useSelector(dictationActor, (snapshot) => ({ phase: phaseOf(snapshot), ...snapshot.context }), sameSnapshot);
}

function sameSnapshot(a: DictationSnapshot, b: DictationSnapshot): boolean {
  return (
    a.phase === b.phase &&
    a.transcript === b.transcript &&
    a.nothingHeard === b.nothingHeard &&
    a.errorCode === b.errorCode &&
    a.submit === b.submit &&
    a.launches === b.launches
  );
}

export function openDictationSettings(): void {
  void Linking.openSettings();
}
