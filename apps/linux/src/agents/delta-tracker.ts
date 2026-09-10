// Port of AgentsDeltaTracker.swift. Server-wide: the last published agent-session list plus a
// monotonically increasing `rev`. `seed` sets the baseline used by `welcome` and `agents.get`
// (no rev bump); `apply` diffs a new list against it and bumps `rev` for a broadcastable
// `agents.delta`.

import type { AgentSession, ServerMessage } from "@relay/protocol";

export class AgentsDeltaTracker {
  private currentRev = 0;
  private current: readonly AgentSession[] = [];

  get rev(): number {
    return this.currentRev;
  }

  get sessions(): readonly AgentSession[] {
    return this.current;
  }

  seed(sessions: readonly AgentSession[]): void {
    this.current = sessions;
  }

  apply(sessions: readonly AgentSession[]): ServerMessage {
    const previous = new Map(this.current.map((session) => [session.id, session]));
    const newIds = new Set(sessions.map((session) => session.id));
    const upsert = sessions.filter((session) => !sameSession(previous.get(session.id), session));
    const remove = this.current.map((session) => session.id).filter((id) => !newIds.has(id));
    this.currentRev += 1;
    this.current = sessions;
    const delta: ServerMessage = { t: "agents.delta", rev: this.currentRev };
    if (upsert.length > 0) delta.upsert = upsert;
    if (remove.length > 0) delta.remove = remove;
    return delta;
  }
}

function sameSession(a: AgentSession | undefined, b: AgentSession): boolean {
  if (a === undefined) return false;
  return (
    a.provider === b.provider &&
    a.title === b.title &&
    a.projectPath === b.projectPath &&
    a.status === b.status &&
    a.statusDetail === b.statusDetail &&
    a.lastActivity === b.lastActivity &&
    a.lastActivityAt === b.lastActivityAt &&
    a.canRespond === b.canRespond
  );
}
