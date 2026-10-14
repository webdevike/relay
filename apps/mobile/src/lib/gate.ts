/** Habit gate rules the phone needs to draw the gate card. Pure, no React Native imports. */
import type { GateActive, GateStatus } from "@relay/protocol";

/** Something that unlocks the gate: a recurring habit, or a one-time task not done yet. */
export interface GateChoice {
  kind: "habit" | "task";
  id: string;
  name: string;
  /** Timer length; null for a task without one (it can be finished at once). */
  minutes: number | null;
  /** Finishing needs a proof photo. */
  photo: boolean;
}

/** Where the card is: picking what to do, waiting out the timer, or ready to mark it done. */
export type GatePhase = "pick" | "running" | "finish";

/** Habits first, then the one-time tasks still open, each in the order the config lists them. */
export function gateChoices(gate: GateStatus): GateChoice[] {
  return [
    ...gate.habits.map((habit): GateChoice => ({ kind: "habit", id: habit.id, name: habit.name, minutes: habit.minutes, photo: habit.photo })),
    ...gate.tasks.filter((task) => !task.done).map((task): GateChoice => ({ kind: "task", id: task.id, name: task.name, minutes: task.minutes, photo: false })),
  ];
}

/** The habit or task whose timer is running; null when none is, or it is no longer configured. */
export function activeChoice(gate: GateStatus): GateChoice | null {
  const active = gate.active;
  if (active === null) return null;
  if (active.kind === "habit") {
    const habit = gate.habits.find((candidate) => candidate.id === active.id);
    return habit === undefined ? null : { kind: "habit", id: habit.id, name: habit.name, minutes: habit.minutes, photo: habit.photo };
  }
  const task = gate.tasks.find((candidate) => candidate.id === active.id);
  return task === undefined ? null : { kind: "task", id: task.id, name: task.name, minutes: task.minutes, photo: false };
}

/** Whole seconds left on the timer at `now` (ms), never negative; 0 when `endsAt` is unreadable. */
export function secondsLeft(active: GateActive, now: number): number {
  const ends = Date.parse(active.endsAt);
  if (Number.isNaN(ends)) return 0;
  return Math.max(0, Math.ceil((ends - now) / 1000));
}

/** Share of the timer already run, 0..1; a zero-length or unreadable timer counts as done. */
export function timerProgress(active: GateActive, now: number): number {
  const start = Date.parse(active.startedAt);
  const ends = Date.parse(active.endsAt);
  if (Number.isNaN(start) || Number.isNaN(ends) || ends <= start) return 1;
  return Math.min(1, Math.max(0, (now - start) / (ends - start)));
}

/**
 * The card's phase at `now`. The countdown runs on the phone's clock from `endsAt`, so "finish"
 * shows the moment the timer is up rather than on the host's next report; the host still has the
 * final say when `gate.done` arrives.
 */
export function gatePhase(gate: GateStatus, now: number): GatePhase {
  if (gate.active === null) return "pick";
  return gate.canFinish || secondsLeft(gate.active, now) === 0 ? "finish" : "running";
}
