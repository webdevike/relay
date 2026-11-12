/**
 * Runs one `turnMachine` actor per echo of a sent assistant turn and keeps its state in
 * `useAssistantStore` (`pending[].state`), where the thread draws it. App-wide, so an echo keeps
 * its state when the thread screen remounts. The echo is added to the store synchronously in
 * `startTurn`, so a second tap in the same frame sees it and sends nothing.
 *
 * Late outcomes come from the command queue (`onCommandReport`): a timed-out turn's ack that comes
 * after all makes its echo `sent`. A row of the turn in the thread (`settlePending` retiring the
 * echo) ends its actor as `landed`.
 */
import { createActor, fromPromise, type Actor } from "xstate";
import type { Command } from "@relay/protocol";
import { onCommandReport, sendCommand } from "@/connection";
import type { Photo } from "@/lib/photo";
import { threadOf, useAssistantStore, type PendingTurnState } from "./assistant";
import { turnMachine } from "./turn.machine";

export interface TurnStart {
  agent: string;
  /** Names the turn on the host (`assistant.turn` `clientId`) and its echo row. */
  clientId: string;
  text: string;
  images: Photo[];
  /** The tap's own delivery: the `sendCommand` (or dictation) promise of the turn. */
  delivery: Promise<void>;
  /** The turn as sent, for Try again; null when it carries no `clientId`, so it cannot be sent again as itself. */
  command: Extract<Command, { kind: "assistant.turn" }> | null;
  /** The host refused it (or it never got out): give the words back and say why. */
  onRefused: (error: unknown) => void;
}

interface Live {
  agent: string;
  clientId: string;
  actor: Actor<typeof turnMachine>;
}

const live = new Map<string, Live>();
const keyOf = (agent: string, clientId: string): string => `${agent}\n${clientId}`;

let wired = false;
/** Listens once, on the first turn: late acks from the queue, and echoes the snapshot retired. */
function wire(): void {
  if (wired) return;
  wired = true;
  onCommandReport((report) => {
    if (report.cmd.kind !== "assistant.turn" || report.cmd.clientId === undefined) return;
    const turn = live.get(keyOf(report.cmd.agent ?? "", report.cmd.clientId));
    if (turn === undefined) return;
    if (report.outcome === "acked") turn.actor.send({ type: "command.lateAck" });
    else if (report.outcome === "nacked") turn.actor.send({ type: "command.lateNack", error: report.error });
  });
  useAssistantStore.subscribe((state) => {
    for (const turn of [...live.values()]) {
      if (!threadOf(state, turn.agent).pending.some((echo) => echo.id === turn.clientId)) turn.actor.send({ type: "turn.landed" });
    }
  });
}

/** Shows `start`'s echo now and follows its turn until it lands, is refused or dismissed. */
export function startTurn(start: TurnStart): void {
  wire();
  const { agent, clientId, command } = start;
  const key = keyOf(agent, clientId);
  if (live.has(key)) return;
  useAssistantStore.getState().addPending(agent, { id: clientId, text: start.text, images: start.images });
  const machine = turnMachine.provide({
    actors: {
      deliver: fromPromise<null, { attempt: number }>(async ({ input }) => {
        await (input.attempt === 0 || command === null ? start.delivery : sendCommand(command));
        return null;
      }),
    },
    actions: {
      reportRefusal: (_, params) => {
        start.onRefused(params.error);
      },
    },
    guards: {
      threadIdle: () => threadOf(useAssistantStore.getState(), agent).snapshot?.busy !== true,
    },
  });
  const actor = createActor(machine, { input: { agent, clientId, canRetry: command !== null } });
  const turn: Live = { agent, clientId, actor };
  live.set(key, turn);
  actor.subscribe((snapshot) => {
    if (snapshot.status !== "done") {
      useAssistantStore.getState().setPendingState(agent, clientId, snapshot.value as PendingTurnState);
      return;
    }
    // Gone from `live` first, so dropping the echo below is not taken for its row landing.
    if (live.get(key) === turn) live.delete(key);
    useAssistantStore.getState().dropPending(agent, clientId);
  });
  actor.start();
}

/** Try again on an unconfirmed echo: the same turn with the same `clientId`. */
export function retryTurn(agent: string, clientId: string): void {
  live.get(keyOf(agent, clientId))?.actor.send({ type: "turn.retry" });
}

/** Takes a stuck unconfirmed echo away. */
export function dismissTurn(agent: string, clientId: string): void {
  live.get(keyOf(agent, clientId))?.actor.send({ type: "turn.dismiss" });
}

/** A fresh `clientId` for a new turn (`MAX_CLIENT_ID` is 64). */
export function newClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
