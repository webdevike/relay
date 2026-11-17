/**
 * Specialist runs (protocol `AgentRun`) as chips in an assistant thread's running row (`agents/RunningChips`):
 * which runs show, newest first, and for how long (the desktop's rule, protocol `recentAgentRuns`).
 */
import { liveAgentRuns, recentAgentRuns, type AgentRun, type AssistantMessage } from "@relay/protocol";

/**
 * The thread's specialist chips at `now`: every run its rows carry (`agents` on status rows and replies), folded
 * per run through `liveAgentRuns`, newest first, then `recentAgentRuns`: a run still out (unless stale after
 * `AGENT_BADGE_STALE_MS`), and a finished one for `AGENT_BADGE_LINGER_MS` after it ended.
 */
export function specialistRuns(messages: readonly AssistantMessage[], now: number): AgentRun[] {
  return recentAgentRuns(
    liveAgentRuns(messages.flatMap((message) => message.agents ?? [])),
    now,
  );
}
