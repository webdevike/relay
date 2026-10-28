// What the canvas agent remembers of the chat it came from: the text turns of the caller's omp
// session file (any session: a desktop chat, an assistant thread, a subagent's own transcript),
// packed for the warm brain's cached system prompt. The turns around the hand-off (the turn that
// started the canvas) plus the latest ones, each clipped, injected system blocks dropped.

import { readFileSync } from "node:fs";
import { textOf } from "../agents/transcript";

export interface ChatContext {
  /** `Isaac: …` / `<agent>: …` paragraphs, oldest first; empty when the file has no text turns. */
  readonly turns: string;
  readonly turnCount: number;
}

/** Turns kept before the hand-off. */
const AROUND_ANCHOR = 16;
/** Latest turns kept after the hand-off window. */
const LATEST = 6;
const MAX_TURN_CHARS = 1200;
/** A subagent's first turn is its whole assignment: keep more of it. */
const MAX_FIRST_TURN_CHARS = 4000;
/** Injected system blocks, IRC notes and skill bodies: not what anyone said. */
const INJECTED = /<(system-[\w-]+|irc|skill|memories|mental_models)[^>]*>[\s\S]*?<\/\1>/g;

interface Entry {
  type?: unknown;
  customType?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/**
 * The chat's turns for `agentName`'s prompt. `human` names the user's turns. The hand-off is the
 * newest turn that mentions starting a canvas (the turn that ran `canvas start`), else the end.
 */
export function chatContext(sessionFile: string, agentName: string, human: string): ChatContext {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return { turns: "", turnCount: 0 };
  }
  const turns: string[] = [];
  let anchor = -1;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "relay-canvas") {
      // An earlier canvas session's rows: the last one marks a previous hand-off.
      anchor = turns.length - 1;
      continue;
    }
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    let text = textOf(entry.message?.content).replace(INJECTED, "").trim();
    if (text === "" || text === "(nothing to report)") continue;
    const max = turns.length === 0 ? MAX_FIRST_TURN_CHARS : MAX_TURN_CHARS;
    if (text.length > max) text = `${text.slice(0, max)}…`;
    turns.push(`${role === "user" ? human : agentName}: ${text}`);
    if (/canvas start|live canvas|canvas\.live/i.test(text)) anchor = turns.length - 1;
  }
  if (turns.length === 0) return { turns: "", turnCount: 0 };
  const at = anchor < 0 ? turns.length - 1 : anchor;
  const start = Math.max(0, at - AROUND_ANCHOR + 3);
  const picked = turns.slice(start, at + 3);
  const latestStart = Math.max(at + 3, turns.length - LATEST);
  const latest = turns.slice(latestStart);
  const parts = [picked.join("\n\n")];
  if (latest.length > 0) parts.push(`[… later in the chat …]\n\n${latest.join("\n\n")}`);
  // A subagent's assignment is its purpose: keep it even when the window starts later.
  if (start > 0 && turns[0] !== undefined) parts.unshift(`${turns[0]}\n\n[… earlier turns omitted …]`);
  return { turns: parts.join("\n\n"), turnCount: picked.length + latest.length };
}
