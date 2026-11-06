import type { AgentSession } from "@relay/protocol";

/**
 * The live bridge session `ref` names (what `--session <id>|me` hands the host): its id, or a
 * subagent's (bridge id `<parent>:<agent id>`; a nested agent id may come dotted, `Parent.Child`,
 * or bare). Null when no live session matches.
 */
export function liveSessionId(sessions: readonly AgentSession[], ref: string): string | null {
  const live = sessions.filter((session) => session.status !== "ended");
  const leaf = (id: string): string => id.split(":").at(-1)?.split(".").at(-1) ?? id;
  const found = live.find((session) => session.id === ref) ?? live.find((session) => session.id.includes(":") && leaf(session.id) === leaf(ref));
  return found?.id ?? null;
}
