/**
 * What an assistant's animated portrait reacts to (`@relay/portrait-motion` `MotionSignals`), read
 * off what the phone already knows about its thread: the host's snapshot and registry status, the
 * omp sessions under it (subagents, background jobs), the call, and whether the last turn failed
 * to send. `motionSignals` is the pure rule; `useMotionSignals` wires it to the stores and only
 * changes identity when a signal does, so a screen re-renders on state edges, not on every frame
 * the host sends.
 */
import { useMemo } from "react";
import type { AgentSession, AssistantSnapshot, AssistantStatus, CallState } from "@relay/protocol";
import type { MotionSignals } from "@relay/portrait-motion";
import { subagentsOf, useAgentsStore } from "./agents";
import { threadOf, useAssistantStore } from "./assistant";
import { useCallStore } from "./call";

export interface MotionInputs {
  snapshot: AssistantSnapshot | null;
  /** A sent turn the host has not listed yet (`AssistantThread.pending`). */
  pending: boolean;
  /** The agent's registry status (`assistant.agents`), when the host sent one. */
  status: AssistantStatus | undefined;
  /** When the agent last replied (`AssistantAgent.lastReply.at`), for a thread not loaded yet. */
  lastReplyAt: number | undefined;
  /** Sign-ins the host took before its snapshot says so (`AssistantThread.signedIn`). */
  signedIn: Readonly<Record<string, true>>;
  /** Subagents or background jobs of the thread's session are running (`sessionWorking`). */
  working: boolean;
  /** This agent's call, if one is up with it. */
  call: { state: CallState; error: string | null } | null;
  /** The last turn this phone sent was refused or timed out (cleared when the next one goes out). */
  turnFailed: boolean;
}

/** Whether `sessionId` (the thread's omp session) has a running subagent or background job. */
export function sessionWorking(sessions: Record<string, AgentSession>, sessionId: string | null): boolean {
  if (sessionId === null || sessionId === "") return false;
  if (sessions[sessionId]?.backgroundJobs?.some((job) => job.state === "running") === true) return true;
  return subagentsOf(sessions, sessionId).some((session) => session.status === "working");
}

/** The portrait's signals for one thread. */
export function motionSignals(input: MotionInputs): MotionSignals {
  const { snapshot, call } = input;
  const busy = snapshot?.busy === true;
  // Status rows are machinery the thread never shows.
  const rows = (snapshot?.messages ?? []).filter((message) => message.role !== "status");
  const newest = rows.at(-1);
  // The thread screen's streaming rule: the host is working and its newest row is a reply already showing words.
  const streaming = busy && !input.pending && newest?.role === "assistant" && newest.text.trim() !== "";
  // A sign-in asked for in the current turn (after Isaac's last message) that he has not answered.
  let signin = false;
  for (let i = rows.length - 1; i >= 0 && rows[i]?.role !== "user"; i -= 1) {
    const row = rows[i];
    if (row?.signin !== undefined && row.signin.submitted !== true && input.signedIn[row.id] !== true) signin = true;
  }
  return {
    running: busy || input.status === "working" || call?.state === "thinking",
    working: input.working,
    talking: streaming || call?.state === "speaking",
    listening: call?.state === "hearing",
    waiting: input.status === "needs_you" || signin,
    failed: input.turnFailed || (call !== null && call.error !== null) || newest?.role === "error",
    activityAt: newest?.at ?? input.lastReplyAt ?? null,
  };
}

/** `motionSignals` for `agent` from the stores; a new object only when a signal changes. */
export function useMotionSignals(agent: string, turnFailed: boolean): MotionSignals {
  const thread = useAssistantStore((state) => threadOf(state, agent));
  const status = useAssistantStore((state) => state.agents?.find((entry) => entry.id === agent)?.status);
  const lastReplyAt = useAssistantStore((state) => state.agents?.find((entry) => entry.id === agent)?.lastReply?.at);
  const sessionId = thread.snapshot?.sessionId ?? null;
  const working = useAgentsStore((state) => sessionWorking(state.sessions, sessionId));
  // Primitives only: the call's microphone level changes many times a second.
  const callState = useCallStore((state) => (state.call?.agent === agent ? state.call.state : null));
  const callError = useCallStore((state) => (state.call?.agent === agent ? state.call.error : null));
  const s = motionSignals({
    snapshot: thread.snapshot,
    pending: thread.pending !== null,
    status,
    lastReplyAt,
    signedIn: thread.signedIn,
    working,
    call: callState === null ? null : { state: callState, error: callError },
    turnFailed,
  });
  return useMemo(
    (): MotionSignals => ({ running: s.running, working: s.working, talking: s.talking, listening: s.listening, waiting: s.waiting, failed: s.failed, activityAt: s.activityAt }),
    [s.running, s.working, s.talking, s.listening, s.waiting, s.failed, s.activityAt],
  );
}
