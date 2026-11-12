/**
 * Runs one `askMachine` actor per ask Isaac answers from this phone (`lib/openAsks.ts`
 * `cardAskKey`/`openAskKey`) and keeps its state in `useAgentsStore().askRecords`, which the ask card
 * (`usePendingAsk`) and the thread's open-ask rows read. App-wide, so a record outlives the screen.
 *
 * The record ends (`host.dropped`) once the host no longer has the ask on any side it was seen on:
 * the session's ask card resolved (`agent.ask.resolved`), and the thread's snapshot no longer lists
 * the open ask.
 */
import { createActor, fromPromise, type Actor } from "xstate";
import { sendCommand } from "@/connection";
import { threadOf, useAssistantStore } from "@/state/assistant";
import { useAgentsStore } from "@/state/agents";
import { retryTurn, startTurn } from "@/state/turns";
import { askMachine, type AskRecordState, type AskReply } from "./ask.machine";

/** Where the ask shows: the session's ask card and/or the thread's open ask. */
export interface AskSources {
  card?: { sessionId: string; askId: string };
  open?: { agent: string; id: string };
}

interface Live {
  actor: Actor<typeof askMachine>;
  card: NonNullable<AskSources["card"]> | null;
  open: NonNullable<AskSources["open"]> | null;
  /** Says why the last send failed, to the screen that sent it. */
  onFailed: (reason: string) => void;
}

const live = new Map<string, Live>();

/** Sends `reply` as one unit: its turn (started once, tried again while unconfirmed) and its closing commands. */
async function deliver(reply: AskReply, onFailed: (reason: string) => void): Promise<null> {
  if (reply.turn !== null) {
    const { agent, clientId, text } = reply.turn;
    const echo = threadOf(useAssistantStore.getState(), agent).pending.find((entry) => entry.id === clientId);
    if (echo === undefined) {
      const command = { kind: "assistant.turn" as const, agent, text, clientId };
      startTurn({
        agent,
        clientId,
        text,
        images: [],
        delivery: sendCommand(command),
        command,
        onRefused: (error) => {
          onFailed(error instanceof Error && error.message !== "" ? error.message : "Not sent.");
        },
      });
    } else if (echo.state === "unconfirmed") {
      retryTurn(agent, clientId);
    }
  }
  await Promise.all(reply.commands.map((command) => sendCommand(command)));
  return null;
}

/** Whether the host still has the ask on any side this record saw it on. */
function stillListed(key: string, turn: Live): boolean {
  const agents = useAgentsStore.getState();
  if (turn.card !== null && agents.askRecords[key]?.cardResolved !== true) {
    const shown = agents.asks[turn.card.sessionId];
    // A newer ask replaced it; an empty slot after a welcome says nothing.
    if (shown === undefined || shown.id === turn.card.askId) return true;
  }
  if (turn.open !== null) {
    const asks = threadOf(useAssistantStore.getState(), turn.open.agent).snapshot?.asks;
    const openId = turn.open.id;
    if (asks === undefined || asks.some((ask) => ask.id === openId)) return true;
  }
  return false;
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  const check = (): void => {
    for (const [key, entry] of [...live]) {
      if (!stillListed(key, entry)) entry.actor.send({ type: "host.dropped" });
    }
  };
  useAgentsStore.subscribe(check);
  useAssistantStore.subscribe(check);
}

function ensure(key: string, sources: AskSources, onFailed: (reason: string) => void): Live {
  wire();
  const existing = live.get(key);
  if (existing !== undefined) {
    existing.card = sources.card ?? existing.card;
    existing.open = sources.open ?? existing.open;
    existing.onFailed = onFailed;
    return existing;
  }
  const machine = askMachine.provide({
    actors: {
      deliver: fromPromise<null, { reply: AskReply; attempt: number }>(({ input }) =>
        deliver(input.reply, (reason) => {
          entry.onFailed(reason);
        }),
      ),
    },
  });
  const actor = createActor(machine);
  const entry: Live = { actor, card: sources.card ?? null, open: sources.open ?? null, onFailed };
  live.set(key, entry);
  actor.subscribe((snapshot) => {
    const store = useAgentsStore.getState();
    if (snapshot.status === "done") {
      if (live.get(key) === entry) live.delete(key);
      store.setAskRecord(key, null);
      return;
    }
    const state = snapshot.value as AskRecordState;
    store.setAskRecord(key, { state, failure: snapshot.context.failure, cardResolved: store.askRecords[key]?.cardResolved ?? false });
    if (state === "failed") entry.onFailed(snapshot.context.failure ?? "Not sent.");
  });
  actor.start();
  return entry;
}

/**
 * Answers ask `key` with `reply`, once: a second answer while one is on its way, or after it
 * reached the host, is ignored. After a failure it answers again with the same turn `clientId`.
 */
export function answerAsk(key: string, reply: AskReply, sources: AskSources, onFailed: (reason: string) => void = () => undefined): void {
  const entry = ensure(key, sources, onFailed);
  const snapshot = entry.actor.getSnapshot();
  const previous = snapshot.context.reply?.turn ?? null;
  const next = reply.turn !== null && previous !== null ? { ...reply, turn: { ...reply.turn, clientId: previous.clientId } } : reply;
  entry.actor.send({ type: "ask.answer", reply: next });
}

/** Dismisses ask `key` unanswered with `reply`'s commands, once. */
export function dismissAsk(key: string, reply: AskReply, sources: AskSources, onFailed: (reason: string) => void = () => undefined): void {
  ensure(key, sources, onFailed).actor.send({ type: "ask.dismiss", reply });
}

/** Sends a failed answer or dismissal of ask `key` again, unchanged. */
export function retryAsk(key: string): void {
  live.get(key)?.actor.send({ type: "ask.retry" });
}
