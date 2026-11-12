// Which assistant's chat a meeting is in, and what that assistant is told about it.
//
// Routing: eCard Systems work goes to the registry's work assistant (Astra), everything else to the
// personal one (Nova). eCard meets on Teams and its calendar is the Outlook one mt-autoname reads, so
// a Teams call, an Outlook event found for the call, or "eCard" in its title or context is work.
//
// Context: while a meeting runs, each turn of its assistant's thread gets the transcript said since
// the thread's previous turn, as a hidden message the relay bridge adds before the turn
// (`MEETING_CONTEXT_TYPE`). The first one carries the whole transcript so far.

import { meetingClock, meetingIsLive, type LiveLine } from "@relay/protocol";
import type { AssistantAgentConfig } from "../assistant/registry";
import type { RecordingMeta } from "./store";

const WORK_APP = /\bteams\b/i;
const WORK_WORDS = /\be-?card\b|\(Outlook: /i;

/** The registry id a meeting goes to; null when the registry has no assistant. */
export function routeMeeting(
  m: Pick<RecordingMeta, "app" | "title" | "context">,
  agents: readonly Pick<AssistantAgentConfig, "id" | "profile">[],
): string | null {
  const work =
    WORK_APP.test(m.app) || WORK_WORDS.test(`${m.title ?? ""}\n${m.context?.annotation ?? ""}`);
  const pick = agents.find((a) => a.profile === (work ? "work" : "personal")) ?? agents[0];
  return pick?.id ?? null;
}

/** The calendar event's title in mt-autoname's annotation (`... (Outlook: "Release Planning")`). */
export function calendarTitle(annotation: string): string | null {
  const title = /\(Outlook: "([^"]+)"\)/.exec(annotation)?.[1]?.trim();
  return title === undefined || title === "" ? null : title;
}

/** A meeting ended this recently still hands its last lines to its assistant's next turn. */
export const CONTEXT_AFTER_END_MS = 30 * 60 * 1000;
/** The first context of a long call keeps its newest lines up to this many characters. */
export const MAX_CONTEXT_CHARS = 80_000;

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** What an assistant's thread was given of a meeting: up to which line, and whether it heard the end. */
export interface Given {
  /** startMs of the last final line given. */
  readonly cursor: number;
  readonly ended: boolean;
}

/**
 * The hidden message for the assistant's next turn and what it then has been given, or null when
 * there is nothing new (`given` null: nothing of this meeting yet, so the whole transcript goes).
 * Drafts (still being said) are shown but not counted as given; the end is told once.
 */
export function meetingContext(
  m: RecordingMeta,
  lines: readonly LiveLine[],
  given: Given | null,
  now: number,
): { text: string; given: Given } | null {
  const said = lines.filter((l) => l.echo !== true && l.text.trim() !== "");
  const since = given?.cursor ?? -1;
  const fresh = said.filter((l) => !l.final || l.startMs > since);
  const live = meetingIsLive(m);
  if (given !== null && !fresh.some((l) => l.final) && (live || given.ended)) return null;
  const cursor = Math.max(since, ...said.filter((l) => l.final).map((l) => l.startMs));
  const title = m.title ?? `${m.app} call`;
  const head = live
    ? `Isaac is in a meeting right now and it is in your chat: "${title}" (${m.app}, started ${clockTime(m.startedAt)}, ${meetingClock(now - m.startedAt)} in).`
    : `The meeting "${title}" (${m.app}, started ${clockTime(m.startedAt)}) ended${m.endedAt === null ? "" : ` at ${clockTime(m.endedAt)}`}; its notes come later on the Meetings page.`;
  const about =
    given === null
      ? "Below is the machine transcript so far: lines from his mic carry his name, the rest is the call audio (R_S2 and the like are unnamed voices). When he asks about the meeting (what did I miss, what was decided, draft my answer, action items), answer from it, briefly while the call runs. Later turns bring only the lines said since."
      : "New in the transcript since your last turn:";
  let body = fresh
    .map((l) => `[${meetingClock(l.startMs)}] ${l.speaker}: ${l.text.trim()}${l.final ? "" : " (still speaking)"}`)
    .join("\n");
  if (body.length > MAX_CONTEXT_CHARS) {
    const cut = body.indexOf("\n", body.length - MAX_CONTEXT_CHARS);
    body = `(earlier lines left out)\n${body.slice(cut + 1)}`;
  }
  const calendar = given === null && m.context !== null ? `\n${m.context.annotation.trim()}` : "";
  return {
    text: `${head}${calendar}\n${about}\n\n${body === "" ? "(nothing new said)" : body}`,
    given: { cursor, ended: !live },
  };
}
