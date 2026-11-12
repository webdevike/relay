import { useCallback } from "react";
import type { AgentAsk, OpenAsk } from "@relay/protocol";
import { useAgentsStore } from "@/state/agents";
import { cardAskKey } from "@/lib/openAsks";
import type { AskAnswer } from "@/agents/askState";
import { answerAsk, dismissAsk, type AskSources } from "./asks";

export interface PendingAsk {
  /** The multiple-choice prompt the session is blocked on; the host sends it to a phone subscribed to the session and replays it on subscribe. */
  ask: AgentAsk | undefined;
  /** Why the last answer or dismissal failed; the card stays, and submitting again sends it again. */
  failure: string | null;
  answer: (results: AskAnswer[]) => void;
  /** Dismisses the ask unanswered (omp's dialog resolves as cancelled). */
  cancel: () => void;
}

export interface PendingAskOptions {
  /** The assistant thread the session runs, and its open asks: the one that stands for the card is closed with it as one unit. */
  thread?: { agent: string; asks: readonly OpenAsk[] | undefined };
  /** Hears why an answer or dismissal failed. */
  onFailed?: (reason: string) => void;
}

/**
 * The ask session `sessionId` is blocked on, wired to `agent.ask.answer` and `agent.ask.cancel`
 * through its answer record (`agents/asks.ts`): the card stays while the answer is on its way and
 * goes once the host acks it; a second submit meanwhile sends nothing; a failure keeps the card with
 * its reason. Only a screen that keeps the session subscribed ever sees an ask here.
 */
export function usePendingAsk(sessionId: string | undefined, options: PendingAskOptions = {}): PendingAsk {
  const { thread, onFailed } = options;
  const pending = useAgentsStore((state) => (sessionId === undefined ? undefined : state.asks[sessionId]));
  const record = useAgentsStore((state) => (sessionId === undefined || pending === undefined ? undefined : state.askRecords[cardAskKey(sessionId, pending.id)]));
  const closed = record !== undefined && (record.state === "answered" || record.state === "dismissed");
  const ask = closed ? undefined : pending;
  const open = ask === undefined ? undefined : thread?.asks?.find((entry) => entry.askId === ask.id && entry.sessionId === sessionId);
  const agent = thread?.agent;
  const answer = useCallback(
    (results: AskAnswer[]) => {
      if (sessionId === undefined || ask === undefined) return;
      const sources: AskSources = { card: { sessionId, askId: ask.id }, ...(open === undefined || agent === undefined ? {} : { open: { agent, id: open.id } }) };
      answerAsk(cardAskKey(sessionId, ask.id), { turn: null, commands: [{ kind: "agent.ask.answer", sessionId, askId: ask.id, results }] }, sources, onFailed);
    },
    [sessionId, ask, open, agent, onFailed],
  );
  const cancel = useCallback(() => {
    if (sessionId === undefined || ask === undefined) return;
    const resolve = open === undefined || agent === undefined ? [] : [{ kind: "assistant.ask.resolve" as const, agent, id: open.id, how: "dismissed" as const }];
    const sources: AskSources = { card: { sessionId, askId: ask.id }, ...(open === undefined || agent === undefined ? {} : { open: { agent, id: open.id } }) };
    dismissAsk(cardAskKey(sessionId, ask.id), { turn: null, commands: [{ kind: "agent.ask.cancel", sessionId, askId: ask.id }, ...resolve] }, sources, onFailed);
  }, [sessionId, ask, open, agent, onFailed]);
  return { ask, failure: record?.state === "failed" ? record.failure : null, answer, cancel };
}
