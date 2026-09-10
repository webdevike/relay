/**
 * Where a finished dictation goes. The trackpad types it into the focused Mac app (`text.insert`,
 * plus Return on a submit); an agent conversation hands it to that session as its next user turn.
 * A screen sets the target while it has focus and restores `insert` when it leaves, so the one
 * dictation actor never needs to know which screen is up.
 */
import type { Command } from "@relay/protocol";
import type { DeliverInput } from "./machine";

export type DictationTarget = { kind: "insert" } | { kind: "agent"; sessionId: string };

const INSERT: DictationTarget = { kind: "insert" };
let target: DictationTarget = INSERT;

export function setDictationTarget(next: DictationTarget): void {
  target = next;
}

export function resetDictationTarget(): void {
  target = INSERT;
}

/**
 * The commands one delivery sends, in order. An agent reply never submits: the reply itself is
 * the turn, and a Return keypress would land in whatever app the Mac has focused.
 */
export function commandsFor(input: DeliverInput, to: DictationTarget): Command[] {
  if (to.kind === "agent") return [{ kind: "agent.reply", sessionId: to.sessionId, text: input.text }];
  const commands: Command[] = [{ kind: "text.insert", text: input.text }];
  if (input.submit) commands.push({ kind: "key.press", key: "return" });
  return commands;
}

/** Sends the delivery for the current target through `send`, stopping at the first rejection. */
export async function deliverDictation(input: DeliverInput, send: (cmd: Command) => Promise<void>): Promise<void> {
  for (const cmd of commandsFor(input, target)) await send(cmd);
}
