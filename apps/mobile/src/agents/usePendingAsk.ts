import { useCallback } from "react";
import type { AgentAsk } from "@relay/protocol";
import { sendCommand } from "@/connection";
import { warn } from "@/connection/log";
import { useAgentsStore } from "@/state/agents";
import type { AskAnswer } from "@/agents/askState";

export interface PendingAsk {
  /** The multiple-choice prompt the session is blocked on; the host sends it to a phone subscribed to the session and replays it on subscribe. */
  ask: AgentAsk | undefined;
  answer: (results: AskAnswer[]) => void;
  /** Dismisses the ask unanswered (omp's dialog resolves as cancelled). */
  cancel: () => void;
}

/**
 * The ask session `sessionId` is blocked on, wired to `agent.ask.answer` and `agent.ask.cancel`.
 * Both drop the card at once; the host also echoes `agent.ask.resolved`. Only a screen that keeps
 * the session subscribed ever sees an ask here.
 */
export function usePendingAsk(sessionId: string | undefined): PendingAsk {
  const ask = useAgentsStore((state) => (sessionId === undefined ? undefined : state.asks[sessionId]));
  const answer = useCallback(
    (results: AskAnswer[]) => {
      if (sessionId === undefined || ask === undefined) return;
      sendCommand({ kind: "agent.ask.answer", sessionId, askId: ask.id, results }).catch((error: unknown) => {
        warn("agent.ask.answer failed", error);
      });
      useAgentsStore.getState().clearAsk(sessionId, ask.id);
    },
    [sessionId, ask],
  );
  const cancel = useCallback(() => {
    if (sessionId === undefined || ask === undefined) return;
    sendCommand({ kind: "agent.ask.cancel", sessionId, askId: ask.id }).catch((error: unknown) => {
      warn("agent.ask.cancel failed", error);
    });
    useAgentsStore.getState().clearAsk(sessionId, ask.id);
  }, [sessionId, ask]);
  return { ask, answer, cancel };
}
