/**
 * Slash-command autocomplete for the typed reply, over the session's skills (`agent.options`).
 * Pure, no React Native imports. Mirrors EvaOS's slash menu (apps/evaos/src/chat_view.rs): before
 * the first space the draft filters commands, prefix matches first and then names containing the
 * text; after `/name ` it filters that command's subcommands. A picked entry completes the draft;
 * sending stays the composer's own send.
 */
import type { AgentSkill } from "@relay/protocol";

/** Rows the menu shows at most; the rest are a few more letters away. */
export const MAX_SLASH_MATCHES = 8;

/**
 * What the slash menu lists for a draft: matching commands, or one command's subcommands once
 * `/name ` is typed. Empty when the draft is not completing a command, or the command is complete.
 */
export function slashMatches(draft: string, skills: readonly AgentSkill[]): AgentSkill[] {
  if (!draft.startsWith("/") || draft.includes("\n")) return [];
  const lower = draft.toLowerCase();
  const space = lower.indexOf(" ");
  let candidates: readonly AgentSkill[] = skills;
  if (space !== -1) {
    // Past the command: only its subcommand word is still completed.
    const head = lower.slice(0, space);
    if (lower.includes(" ", space + 1)) return [];
    candidates = skills.find((skill) => skill.command.toLowerCase() === head)?.choices ?? [];
  }
  const query = space === -1 ? lower.slice(1) : lower.slice(space + 1);
  const prefix: AgentSkill[] = [];
  const contains: AgentSkill[] = [];
  for (const entry of candidates) {
    // A command typed out in full is complete; one with subcommands still has a step left.
    if (entry.command.toLowerCase() === lower && entry.choices === undefined) continue;
    const name = entry.name.toLowerCase();
    // The word being typed: `skill:review` for an authored skill, `set` for `/goal set`.
    const command = entry.command.slice(entry.command.lastIndexOf(" ") + 1).replace(/^\//, "").toLowerCase();
    if (name.startsWith(query) || command.startsWith(query)) prefix.push(entry);
    else if (name.includes(query) || command.includes(query)) contains.push(entry);
  }
  return [...prefix, ...contains].slice(0, MAX_SLASH_MATCHES);
}

/**
 * The draft once `entry` is picked: its command, plus a space when something follows (dictated
 * text, or the subcommands a command with choices opens next).
 */
export function completeSlash(entry: AgentSkill): string {
  return entry.takesText || entry.choices !== undefined ? `${entry.command} ` : entry.command;
}
