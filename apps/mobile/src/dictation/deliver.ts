/**
 * Where a finished dictation goes. The trackpad types it into the focused app (`text.insert`,
 * plus Return on a submit); an agent session gets it as `agent.reply`, where the same flick-up
 * decides whether it is sent as the next turn or only placed in the session's input. A screen sets
 * the target while it has focus and restores `insert` when it leaves, so the one dictation actor
 * never needs to know which screen is up.
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
 * The text as the host receives it: the armed slash command, then the dictation (or the command alone),
 * then the pasted text on its own paragraph.
 */
export function deliveredText(input: DeliverInput): string {
  const spoken = input.skill === null ? input.text : input.text === "" ? input.skill : `${input.skill} ${input.text}`;
  if (input.pasted === null) return spoken;
  return spoken === "" ? input.pasted : `${spoken}\n\n${input.pasted}`;
}

/** The commands one delivery sends, in order. Images only go to an agent; the trackpad has nowhere to put them. */
export function commandsFor(input: DeliverInput, to: DictationTarget): Command[] {
  const text = deliveredText(input);
  if (to.kind === "agent") {
    const images = input.images.map(({ mimeType, data }) => ({ mimeType, data }));
    return [{ kind: "agent.reply", sessionId: to.sessionId, text, submit: input.submit, ...(images.length > 0 ? { images } : {}) }];
  }
  const commands: Command[] = [{ kind: "text.insert", text }];
  if (input.submit) commands.push({ kind: "key.press", key: "return" });
  return commands;
}

/** Sends the delivery for the current target through `send`, stopping at the first rejection. */
export async function deliverDictation(input: DeliverInput, send: (cmd: Command) => Promise<void>): Promise<void> {
  for (const cmd of commandsFor(input, target)) await send(cmd);
}
