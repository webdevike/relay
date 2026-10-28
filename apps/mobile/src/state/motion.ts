/**
 * What an assistant's animated portrait reacts to (`@relay/portrait-motion` `MotionSignals`), read
 * off what the phone already knows about its thread: the host's snapshot and registry status, the
 * omp sessions under it (the tool it runs, its subagents and background jobs), the call, and
 * whether the last turn failed to send. The mapping is calm: a running turn (its reply streaming
 * included) thinks, researches or works by the tools it runs; a call's speaking and hearing are not
 * running; needing Isaac and failing only colour the status dot. `motionSignals` is the pure rule;
 * `useMotionSignals` wires it to the stores and only changes identity when a signal does.
 */
import { useMemo } from "react";
import type { AgentSession, AssistantSnapshot, AssistantStatus, CallState } from "@relay/protocol";
import { IDLE_SIGNALS, statusDot, toolKind, type DotTone, type MotionSignals, type ToolKind } from "@relay/portrait-motion";
import { subagentsOf, useAgentsStore } from "./agents";
import { threadOf, useAssistantStore } from "./assistant";
import { useCallStore } from "./call";

export interface MotionInputs {
  snapshot: AssistantSnapshot | null;
  /** The agent's registry status (`assistant.agents`), when the host sent one. */
  status: AssistantStatus | undefined;
  /** When the agent last replied (`AssistantAgent.lastReply.at`), for a thread not loaded yet. */
  lastReplyAt: number | undefined;
  /** Sign-ins the host took before its snapshot says so (`AssistantThread.signedIn`). */
  signedIn: Readonly<Record<string, true>>;
  /** What the thread's running tools are doing (`threadTool`). */
  tool: ToolKind | null;
  /** This agent's call, if one is up with it. */
  call: { state: CallState; error: string | null } | null;
  /** The last turn this phone sent was refused or timed out (cleared when the next one goes out). */
  turnFailed: boolean;
}

/**
 * What the tools of `sessionId` (the thread's omp session) are doing: the tool the session itself
 * runs (its `statusDetail` while working), else its working subagents' (research when any of them
 * researches), else work while a background job runs; null when nothing runs.
 */
export function threadTool(sessions: Record<string, AgentSession>, sessionId: string | null): ToolKind | null {
  if (sessionId === null || sessionId === "") return null;
  const session = sessions[sessionId];
  if (session?.status === "working" && session.statusDetail !== undefined && session.statusDetail.trim() !== "") {
    return toolKind(session.statusDetail);
  }
  const subagents = subagentsOf(sessions, sessionId).filter((sub) => sub.status === "working");
  if (subagents.length > 0) {
    return subagents.some((sub) => sub.statusDetail !== undefined && sub.statusDetail.trim() !== "" && toolKind(sub.statusDetail) === "research") ? "research" : "work";
  }
  return session?.backgroundJobs?.some((job) => job.state === "running") === true ? "work" : null;
}

/** The portrait's signals for one thread. */
export function motionSignals(input: MotionInputs): MotionSignals {
  const { snapshot, call } = input;
  // Status rows are machinery the thread never shows.
  const rows = (snapshot?.messages ?? []).filter((message) => message.role !== "status");
  const newest = rows.at(-1);
  // A sign-in asked for in the current turn (after Isaac's last message) that he has not answered.
  let signin = false;
  for (let i = rows.length - 1; i >= 0 && rows[i]?.role !== "user"; i -= 1) {
    const row = rows[i];
    if (row?.signin !== undefined && row.signin.submitted !== true && input.signedIn[row.id] !== true) signin = true;
  }
  return {
    running: snapshot?.busy === true || input.status === "working" || call?.state === "thinking",
    tool: input.tool,
    waiting: input.status === "needs_you" || signin,
    failed: input.turnFailed || (call !== null && call.error !== null) || newest?.role === "error",
    activityAt: newest?.at ?? input.lastReplyAt ?? null,
  };
}

/** The status dot of an agent known only by its registry status (lists and widgets). */
export function listingDot(status: AssistantStatus | undefined): DotTone {
  return statusDot({ ...IDLE_SIGNALS, running: status === "working", waiting: status === "needs_you" });
}

/** `motionSignals` for `agent` from the stores; a new object only when a signal changes. */
export function useMotionSignals(agent: string, turnFailed: boolean): MotionSignals {
  const thread = useAssistantStore((state) => threadOf(state, agent));
  const status = useAssistantStore((state) => state.agents?.find((entry) => entry.id === agent)?.status);
  const lastReplyAt = useAssistantStore((state) => state.agents?.find((entry) => entry.id === agent)?.lastReply?.at);
  const sessionId = thread.snapshot?.sessionId ?? null;
  const tool = useAgentsStore((state) => threadTool(state.sessions, sessionId));
  // Primitives only: the call's microphone level changes many times a second.
  const callState = useCallStore((state) => (state.call?.agent === agent ? state.call.state : null));
  const callError = useCallStore((state) => (state.call?.agent === agent ? state.call.error : null));
  const s = motionSignals({
    snapshot: thread.snapshot,
    status,
    lastReplyAt,
    signedIn: thread.signedIn,
    tool,
    call: callState === null ? null : { state: callState, error: callError },
    turnFailed,
  });
  return useMemo(
    (): MotionSignals => ({ running: s.running, tool: s.tool, waiting: s.waiting, failed: s.failed, activityAt: s.activityAt }),
    [s.running, s.tool, s.waiting, s.failed, s.activityAt],
  );
}
