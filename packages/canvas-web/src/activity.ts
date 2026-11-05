// What is happening in the room, for the room bar and the card spinners: who is here, what each
// agent is doing right now (thinking, editing the board, running a tool, waiting on a handoff,
// idle, just done) from presence, cards an agent added in this burst, and live-widget queries and
// prototype frames still loading.
import { useSyncExternalStore } from "react";
import type { Presence } from "../../canvas-live/src/shared";

export type PersonState = "thinking" | "editing" | "tool" | "waiting" | "done" | "idle";

export interface Person {
  /** One entry per person: a human's several tabs are one. */
  key: string;
  name: string;
  color: string;
  /** Avatar URL (host-relative), agents that have one. */
  avatar: string | undefined;
  agent: boolean;
  state: PersonState;
  /** What they are doing, in a few words ("running a command…", "done"); empty for people. */
  label: string;
}

const MAX_TASK = 40;
/** An agent that just went quiet keeps showing what it did this long, so quick steps read as one calm line. */
export const SETTLE_MS = 1200;
/** Then it reads "done" this long before settling to idle. */
export const DONE_MS = 6000;

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_TASK ? `${one.slice(0, MAX_TASK - 1)}…` : one;
}

/** One presence as a person, right now (no memory of what came before). */
function describePerson(p: Presence, added: number): Person | null {
  if (!p.user) return null;
  const { name, color, avatar } = p.user;
  const base = { key: `${p.user.kind}:${name.toLowerCase()}`, name, color, avatar, agent: p.user.kind === "agent" };
  if (!base.agent) return { ...base, state: "idle", label: "" };
  const status = p.status ?? "idle";
  const doing = (p.doing ?? "").trim();
  if (status === "moving" || status === "typing" || status === "drawing") {
    const label =
      status === "drawing"
        ? "connecting cards"
        : added > 0
          ? `adding ${added === 1 ? "a card" : `${String(added)} cards`}`
          : "editing the board";
    return { ...base, state: "editing", label };
  }
  if (doing !== "") return { ...base, state: "tool", label: clip(doing) };
  if (status === "thinking") return { ...base, state: "thinking", label: "thinking…" };
  if ((p.task ?? "") !== "")
    return { ...base, state: "waiting", label: `waiting on a handoff: ${clip(p.task ?? "")}` };
  return { ...base, state: "idle", label: "idle" };
}

const RANK: Record<PersonState, number> = { editing: 5, tool: 4, thinking: 3, waiting: 2, done: 1, idle: 0 };

/** Everyone in the room, once each: humans first, agents after, each agent in the busiest state any of its presences has. */
export function describeRoom(presences: Iterable<Presence>, added: number): Person[] {
  const byKey = new Map<string, Person>();
  for (const p of presences) {
    const next = describePerson(p, added);
    if (next === null) continue;
    const have = byKey.get(next.key);
    if (have === undefined || RANK[next.state] > RANK[have.state]) byKey.set(next.key, next);
  }
  const all = [...byKey.values()];
  return [...all.filter((x) => !x.agent), ...all.filter((x) => x.agent)];
}

/**
 * Remembers who was busy a moment ago, so an agent that stops reads as its last line for a beat,
 * then "done" for a few seconds, then idle: the end of a piece of work is something you can see.
 */
export class DoneTracker {
  private readonly last = new Map<string, { at: number; line: Person }>();

  apply(people: readonly Person[], now: number): Person[] {
    return people.map((person) => {
      if (!person.agent) return person;
      if (person.state !== "idle" && person.state !== "done") {
        this.last.set(person.key, { at: now, line: person });
        return person;
      }
      const seen = this.last.get(person.key);
      if (seen === undefined) return person;
      const age = now - seen.at;
      if (age < SETTLE_MS) return seen.line;
      if (age < DONE_MS) return { ...person, state: "done", label: "done" };
      this.last.delete(person.key);
      return person;
    });
  }

  /** Something is still holding or showing done: the bar needs to re-render as time passes. */
  get pending(): boolean {
    return this.last.size > 0;
  }
}

// ---------- loading cards: live-widget queries and prototype frames in flight ----------

const loading = new Map<string, number>();
const listeners = new Set<() => void>();
let total = 0;

function emit(): void {
  for (const l of listeners) l();
}

/** Marks card `id` loading until the returned function is called (once). */
export function beginLoad(id: string): () => void {
  loading.set(id, (loading.get(id) ?? 0) + 1);
  total++;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (loading.get(id) ?? 1) - 1;
    if (n <= 0) loading.delete(id);
    else loading.set(id, n);
    total--;
    emit();
  };
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function useCardLoading(id: string): boolean {
  return useSyncExternalStore(subscribe, () => loading.has(id));
}

export function useWidgetsLoading(): number {
  return useSyncExternalStore(subscribe, () => total);
}
