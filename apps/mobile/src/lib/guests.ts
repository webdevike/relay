/**
 * Guest rows of an assistant thread: another assistant joined, said something, left, or works on
 * something in its own chat (the host's consult, `relay-guest` rows). A host with
 * ASSISTANT_GUESTS_FEATURE sends each with its entry; joined and left come as `status` rows, the
 * rest as titled `card` rows (what a phone without guests shows). Pure, no React Native imports.
 */
import type { AssistantMessage, GuestEntry, GuestWork } from "@relay/protocol";

/** How a row draws: a quiet joined/left line, the guest's bubble, or a work card. */
export type GuestRowKind = "line" | "say" | "work";

/** How `message` draws as a guest row when the host sends guests (`guests`); null for any other row. */
export function guestRowKind(message: AssistantMessage, guests: boolean): GuestRowKind | null {
  const entry = message.guest;
  if (!guests || entry === undefined) return null;
  if (entry.kind === "join" || entry.kind === "leave") return "line";
  if (entry.kind === "say") return "say";
  return entry.work === undefined ? null : "work";
}

/** The assistant thread a work card opens: the agent its link names (`agent:<id>`), else the guest's own. */
export function workTarget(entry: GuestEntry): { pathname: "/eva"; params: { agent: string } } {
  const link = entry.work?.link;
  const agent = link?.startsWith("agent:") === true && link.length > "agent:".length ? link.slice("agent:".length) : entry.agent.id;
  return { pathname: "/eva", params: { agent } };
}

/** The card's time: how long the work has run (`0:05`) while it works, how long it took (`2m 14s`) once done; null when it stopped. */
export function workTime(work: GuestWork, now: number): string | null {
  if (work.state === "failed") return null;
  const s = Math.floor(Math.max(0, (work.endedAt ?? now) - work.startedAt) / 1000);
  if (work.state === "working") return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
  if (s < 60) return `${s}s`;
  return s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
