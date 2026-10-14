import type { AgentApproval } from "@relay/protocol";
import { useApprovalDecision } from "@/inbox/useApprovalDecision";
import { ApprovalCard } from "./ApprovalCard";

/** `ApprovalCard` wired to `session`'s pending approval: Face ID for a destructive call, then `agent.approve`. */
export function SessionApprovalCard({ sessionId, approval }: { sessionId: string; approval: AgentApproval }) {
  const decision = useApprovalDecision(sessionId, approval);
  return <ApprovalCard approval={approval} busy={decision.busy} error={decision.error} onApprove={decision.approve} onDeny={decision.deny} />;
}
