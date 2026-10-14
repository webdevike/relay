import { useCallback, useState } from "react";
import type { AgentApproval } from "@relay/protocol";
import { approve, deny, type Outcome } from "./answer";
import { answerDeps } from "./respond";

function errorText(outcome: Outcome): string | null {
  switch (outcome.status) {
    case "cancelled":
      return "Face ID didn't confirm. Nothing was approved.";
    case "offline":
      return "Can't reach your Mac.";
    case "failed":
      return outcome.message;
    case "sent":
    case "ignored":
      return null;
  }
}

/**
 * Approve or deny the tool call `sessionId` is blocked on. Approving a destructive call asks for
 * Face ID first (`approve` in `answer.ts`); the card clears when the host reports the approval
 * resolved, not when the command is acked, so a refused approval stays on screen with its reason.
 */
export function useApprovalDecision(sessionId: string, approval: AgentApproval): { busy: boolean; error: string | null; approve: () => void; deny: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    (act: () => Promise<Outcome>) => {
      setBusy(true);
      setError(null);
      act()
        .then((outcome) => {
          setError(errorText(outcome));
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [],
  );
  const target = { sessionId, approvalId: approval.id };
  return {
    busy,
    error,
    approve: () => {
      run(() => approve({ ...target, requiresBiometric: approval.requiresBiometric, destructive: approval.destructive }, answerDeps));
    },
    deny: () => {
      run(() => deny(target, answerDeps));
    },
  };
}
