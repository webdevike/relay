/**
 * Where a finished dictation goes. The trackpad types it into the focused app (`text.insert`,
 * plus Return on a submit); an agent session gets it as `agent.reply`, always as the next turn;
 * a flick up in the inbox starts a new session with it (`agent.start` with the words as the first
 * prompt). A screen pushes its target while it has focus and releases that entry when it leaves
 * (`targetStack.machine.ts`), so the one dictation actor never needs to know which screen is up. The inbox
 * also registers a launch listener so it can show the new session, words first, before the host
 * has even opened it.
 */
import type { Command } from "@relay/protocol";
import { createActor } from "xstate";
import type { DeliverInput } from "./machine";
import { tagged } from "./surface";
import { targetOf, targetStackMachine, type DictationTarget } from "./targetStack.machine";

const targets = createActor(targetStackMachine).start();
let nextOwner = 0;
let onLaunch: ((prompt: string, delivery: Promise<void>) => void) | null = null;
let launchThinkingLevel = "";

/**
 * Points dictation at `target` until the returned release runs. Release drops only this entry
 * (twice is harmless), so a screen's blur can never clear the target the next screen pushed.
 */
export function pushDictationTarget(target: DictationTarget): () => void {
  nextOwner += 1;
  const owner = nextOwner;
  targets.send({ type: "target.pushed", owner, target });
  return () => {
    targets.send({ type: "target.released", owner });
  };
}

/** Thinking level a launched session opens with; empty leaves omp's default. The inbox mirrors the setting here. */
export function setLaunchThinkingLevel(level: string): void {
  launchThinkingLevel = level;
}

/**
 * Called with the delivered text (possibly empty) the moment a launch dictation is sent, before
 * any command goes out, with the delivery itself so a refused launch can show where it failed.
 */
export function setLaunchListener(
  listener: ((prompt: string, delivery: Promise<void>) => void) | null,
): void {
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

/**
 * The commands one delivery sends, in order. Images only go to an agent; the trackpad has nowhere to put them.
 * `clientId` names an assistant turn, so a resend of it is delivered once.
 */
export function commandsFor(input: DeliverInput, to: DictationTarget, clientId: string): Command[] {
  const text = deliveredText(input);
  if (input.launch) {
    return [
      {
        kind: "agent.start",
        ...(text.length > 0 ? { prompt: tagged(text) } : {}),
        ...(launchThinkingLevel.length > 0 ? { thinkingLevel: launchThinkingLevel } : {}),
      },
    ];
  }
  if (to.kind === "assistant") {
    const images = input.images.map(({ mimeType, data }) => ({ mimeType, data }));
    return [
      { kind: "assistant.turn", agent: to.agent, text, clientId, ...(images.length > 0 ? { images } : {}) },
    ];
  }
  if (to.kind === "agent") {
    const images = input.images.map(({ mimeType, data }) => ({ mimeType, data }));
    const reply: Command = {
      kind: "agent.reply",
      sessionId: to.sessionId,
      text: tagged(text),
      submit: true,
      ...(images.length > 0 ? { images } : {}),
    };
    return to.pendingAskId === undefined ? [reply] : [{ kind: "agent.ask.cancel", sessionId: to.sessionId, askId: to.pendingAskId }, reply];
  }
  const commands: Command[] = [{ kind: "text.insert", text }];
  if (input.submit) commands.push({ kind: "key.press", key: "return" });
  return commands;
}

/** Sends the delivery for the top target through `send`, stopping at the first rejection. */
export async function deliverDictation(
  input: DeliverInput,
  send: (cmd: Command) => Promise<void>,
): Promise<void> {
  const target = targetOf(targets.getSnapshot());
  if (target.kind === "local" && !input.launch) return target.onText(deliveredText(input));
  const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const commands = commandsFor(input, target, clientId);
  const run = async (): Promise<void> => {
    for (const cmd of commands) {
      // The ask may have closed on another device already; that must not lose the reply behind it.
      if (cmd.kind === "agent.ask.cancel") await send(cmd).catch(() => undefined);
      else await send(cmd);
    }
  };
  if (target.kind === "assistant") {
    const delivery = Promise.resolve().then(run);
    target.onTurn?.(deliveredText(input), delivery, clientId);
    return delivery;
  }
  if (!input.launch) return run();
  // The listener hears of the launch before the first command leaves.
  const delivery = Promise.resolve().then(run);
  onLaunch?.(deliveredText(input), delivery);
  return delivery;
}
