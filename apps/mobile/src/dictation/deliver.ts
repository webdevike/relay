/**
 * Where a finished dictation goes. The trackpad types it into the focused app (`text.insert`,
 * plus Return on a submit); an agent session gets it as `agent.reply`, always as the next turn;
 * a flick up in the inbox starts a new session with it (`agent.start` with the words as the first
 * prompt). A screen sets the target while it has focus and restores `insert` when it leaves, so
 * the one dictation actor never needs to know which screen is up. The inbox also registers a
 * launch listener so it can show the new session, words first, before the host has even opened it.
 */
import type { Command } from "@relay/protocol";
import type { DeliverInput } from "./machine";

export type DictationTarget = { kind: "insert" } | { kind: "agent"; sessionId: string };

const INSERT: DictationTarget = { kind: "insert" };
let target: DictationTarget = INSERT;
let onLaunch: ((prompt: string) => void) | null = null;

export function setDictationTarget(next: DictationTarget): void {
  target = next;
}

export function resetDictationTarget(): void {
  target = INSERT;
}

/** Called with the delivered text (possibly empty) the moment a launch dictation is sent. */
export function setLaunchListener(listener: ((prompt: string) => void) | null): void {
  onLaunch = listener;
}

/**
 * The text as the host receives it: the armed slash command, then the dictation (or the command alone),
 * then the pasted text on its own paragraph.
 */
export function deliveredText(input: DeliverInput): string {
  const spoken =
    input.skill === null
      ? input.text
      : input.text === ""
        ? input.skill
        : `${input.skill} ${input.text}`;
  if (input.pasted === null) return spoken;
  return spoken === "" ? input.pasted : `${spoken}\n\n${input.pasted}`;
}

/** The commands one delivery sends, in order. Images only go to an agent; the trackpad has nowhere to put them. */
export function commandsFor(input: DeliverInput, to: DictationTarget): Command[] {
  const text = deliveredText(input);
  if (input.launch) return [text.length > 0 ? { kind: "agent.start", prompt: text } : { kind: "agent.start" }];
  if (to.kind === "agent") {
    const images = input.images.map(({ mimeType, data }) => ({ mimeType, data }));
    return [
      {
        kind: "agent.reply",
        sessionId: to.sessionId,
        text,
        submit: true,
        ...(images.length > 0 ? { images } : {}),
      },
    ];
  }
  const commands: Command[] = [{ kind: "text.insert", text }];
  if (input.submit) commands.push({ kind: "key.press", key: "return" });
  return commands;
}

/** Sends the delivery for the current target through `send`, stopping at the first rejection. */
export async function deliverDictation(
  input: DeliverInput,
  send: (cmd: Command) => Promise<void>,
): Promise<void> {
  if (input.launch) onLaunch?.(deliveredText(input));
  for (const cmd of commandsFor(input, target)) await send(cmd);
}
