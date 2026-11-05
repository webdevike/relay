// Small pure helpers for the comment pins and threads UI (pins.tsx, log.tsx): relative times and
// whose face a message or a person wears. No DOM, so tests call them directly.

import type { Presence, User } from "../../canvas-live/src/shared";
import type { ThreadSnap } from "../../canvas-live/src/threads";

/** When a message was written, short: "now", "4m", "2h", "3d", else the date ("Nov 5"). */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${String(h)}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${String(d)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The avatar URL `who` is drawn with: its own, else (an agent going by the room agent's name)
 * the room agent's, so the canvas self wears its assistant's real face everywhere even where a
 * presence or a message came without one. Undefined: draw the initial.
 */
export function avatarFor(
  who: { name: string; kind?: "human" | "agent"; avatar?: string | undefined },
  roomAgent: { name: string; avatar?: string | undefined } | null,
): string | undefined {
  if (who.avatar !== undefined && who.avatar !== "") return who.avatar;
  if (who.kind === "human" || roomAgent === null) return undefined;
  return roomAgent.name.toLowerCase() === who.name.toLowerCase() ? roomAgent.avatar : undefined;
}

/** An agent answering in a thread right now: the reply streaming in, or what it is doing before it writes. */
export interface ThreadDraft {
  user: User;
  /** The reply as written so far; empty while it is still working. */
  text: string;
  /** What it is doing, for the row while `text` is empty ("thinking…", "building the mockup…"). */
  label: string;
}

/** Who is answering `thread` right now, from presence; null when nobody is. */
export function threadDraft(presences: Iterable<Presence>, thread: ThreadSnap): ThreadDraft | null {
  for (const p of presences) {
    if (p.user?.kind !== "agent") continue;
    if (p.bubble?.thread === thread.id && p.bubble.streaming === true && p.bubble.text !== "")
      return { user: p.user, text: p.bubble.text, label: "writing" };
    const working = p.status !== undefined && p.status !== "idle";
    if (working && p.replyTo != null && thread.messages.some((m) => m.id === p.replyTo))
      return { user: p.user, text: "", label: (p.doing ?? "").trim() || "thinking…" };
  }
  return null;
}