import { createContext, useContext, useSyncExternalStore } from "react";
import { type ArrivalPhase, ArrivalStore } from "./arrival";

/** Cards arriving on this page (the board feeds it, each card reads its own entry). */
export const arrivals = new ArrivalStore();

/** The card's arrival, for the text fields inside it (null when it is not arriving). */
export const ArrivalContext = createContext<{ phase: ArrivalPhase; revealAt: number } | null>(null);

export function useArrivalPhase(id: string): ArrivalPhase | null {
  return useSyncExternalStore(arrivals.subscribe, () => arrivals.phase(id));
}

export function useArrival() {
  return useContext(ArrivalContext);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
