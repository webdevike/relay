/**
 * A widget tap that answers an assistant rather than the chat it sits in: a ```ui / ```openui
 * button with `agent` (`@ToAssistant("text", "penny")`) or a Mantine page's
 * `relay.reply(text, {agent})`. It works anywhere, a board tile included (where a plain reply has
 * no session and stays disabled): the text goes as Isaac's `assistant.turn` to that assistant,
 * through the same turn path as his own (`state/turns.ts`, so its thread shows the echo), with a
 * fresh `clientId`. A board tile shows the outcome as a quiet caption (`TileSend`).
 */
import { sendCommand } from "@/connection";
import { CommandError } from "@/connection/commands";
import { threadOf, useAssistantStore } from "@/state/assistant";
import { newClientId, startTurn } from "@/state/turns";

/** What became of a send: acked, refused (with the host's reason), or no answer in time (it may still land). */
export type SendOutcome =
  { kind: "sent" } | { kind: "refused"; message: string } | { kind: "unconfirmed" };

/** Where a widget's reply goes: the session it sits in (null where there is none) or an assistant's thread. */
export interface ReplyTargets {
  session: ((text: string) => void) | null;
  assistant: (agent: string, text: string) => void;
}

/** A widget's reply: with `agent` to that assistant's thread, else to the session (nothing without one). */
export function routeReply(text: string, agent: string | undefined, targets: ReplyTargets): void {
  if (agent !== undefined) targets.assistant(agent, text);
  else targets.session?.(text);
}

/**
 * Sends `text` as Isaac's turn to `agent` and settles with the outcome (never rejects). Null when
 * the same words to that thread are still on their way, so a double tap sends once.
 */
export function sendToAssistant(agent: string, text: string): Promise<SendOutcome> | null {
  const inFlight = threadOf(useAssistantStore.getState(), agent).pending.some(
    (echo) => echo.text === text && echo.state === "sending",
  );
  if (inFlight) return null;
  const clientId = newClientId();
  const command = { kind: "assistant.turn" as const, agent, text, clientId };
  const delivery = sendCommand(command);
  // The outcome below is the caller's to show; the echo in the thread follows the turn on its own.
  startTurn({ agent, clientId, text, images: [], delivery, command, onRefused: () => undefined });
  return delivery.then(
    (): SendOutcome => ({ kind: "sent" }),
    (error: unknown): SendOutcome => {
      if (error instanceof CommandError && error.code === "timeout") return { kind: "unconfirmed" };
      return {
        kind: "refused",
        message:
          error instanceof Error && error.message !== ""
            ? error.message
            : "the host did not take it",
      };
    },
  );
}

/** The tile's caption for `outcome`, `title` being the assistant's name. */
export function sendCaption(outcome: SendOutcome, title: string): string {
  switch (outcome.kind) {
    case "sent":
      return `Sent to ${title}`;
    case "unconfirmed":
      return `Not confirmed by ${title} yet`;
    case "refused":
      return `Not sent: ${outcome.message}`;
  }
}
