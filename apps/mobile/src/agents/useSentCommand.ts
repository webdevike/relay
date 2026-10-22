/**
 * The slash command the phone last sent a session, while the session has not answered it (see
 * lib/sentCommand.ts). One that never gets an answer is dropped at its timeout, so a command omp
 * ran silently (`/rename`) or a handoff an older omp never reports stops showing on its own.
 */
import { useEffect } from "react";
import { useAgentsStore } from "@/state/agents";
import { sentRemaining, type SentCommand } from "@/lib/sentCommand";

export function useSentCommand(sessionId: string | undefined): SentCommand | undefined {
  const sent = useAgentsStore((state) => (sessionId === undefined ? undefined : state.sent[sessionId]));
  useEffect(() => {
    if (sessionId === undefined || sent === undefined) return;
    const timer = setTimeout(() => {
      useAgentsStore.getState().dropSent(sessionId, sent.at);
    }, Math.max(0, sentRemaining(sent, Date.now())));
    return () => {
      clearTimeout(timer);
    };
  }, [sessionId, sent]);
  return sent;
}
