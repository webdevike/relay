// What each source of the activity list says, as `ActivityItem`s (the merge and the service live
// beside this). Pure: the service hands in what it read from the bridge, the artifacts, herdr and
// the canvas rooms.
import { basename } from "node:path";
import { SUBAGENT_STALE_MS, type ActivityItem, type ActivityStatus, type AgentSession, type Artifact, type CanvasRoomInfo } from "@relay/protocol";
import type { HerdrAgent } from "../agents/herdr";

/** `assistant:nova` for an assistant thread or a session it owns (auto-work), else the session's own `session:<id>`. */
export function sessionOwner(session: AgentSession): string {
  const assistant = session.assistant ?? session.owner;
  return assistant === undefined ? `session:${session.id}` : `assistant:${assistant}`;
}

/**
 * Sessions of their own that are doing something: working, or blocked on Isaac (`question` says
 * what he is asked). Idle and ended ones are not reported; the merge turns a session that was
 * active into a finished one. Subagents (`parentId`) are the helpers' rows, not these.
 */
export function sessionItems(sessions: readonly AgentSession[], question: (sessionId: string) => string | null): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const session of sessions) {
    if (session.parentId !== undefined) continue;
    const waiting = session.status === "waiting" || session.status === "needs_permission";
    if (session.status !== "working" && !waiting) continue;
    const asked = waiting ? (question(session.id) ?? session.statusDetail ?? (session.status === "needs_permission" ? "Needs your approval" : "Asking you something")) : null;
    out.push({
      id: `session:${session.id}`,
      kind: "session",
      owner: sessionOwner(session),
      title: session.job?.name ?? session.title,
      status: waiting ? "waiting" : "working",
      intent: asked ?? session.lastActivity,
      startedAt: session.lastActivityAt,
      updatedAt: session.lastActivityAt,
      ...(session.model === undefined ? {} : { model: session.model }),
      open: { to: "chat", thread: session.assistant === undefined ? `session:${session.id}` : `assistant:${session.assistant}`, session: session.id },
    });
  }
  return out;
}

/** The helpers `ArtifactService.helpers()` lists: running ones, and ones that ended today. */
export function helperItems(helpers: readonly { thread: string; item: Artifact }[], now: number): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const { thread, item } of helpers) {
    const sub = item.subagent;
    if (sub === undefined || item.path === undefined) continue;
    // The same rule as every client's `subagentView`: a quiet "running" one is gone, not running.
    const status: ActivityStatus = sub.state === "running" && now - item.lastSeen > SUBAGENT_STALE_MS ? "done" : sub.state === "running" ? "working" : sub.state;
    out.push({
      id: `helper:${item.path}`,
      kind: "helper",
      owner: thread,
      title: item.title,
      status,
      intent: sub.line ?? "",
      startedAt: sub.startedAt,
      updatedAt: sub.endedAt ?? item.lastSeen,
      open: { to: "subagent", file: item.path, name: item.title },
    });
  }
  return out;
}

/** The herdr panes that run something other than omp (claude, codex, muse, opencode), as harnesses. */
export function harnessItems(agents: readonly HerdrAgent[], now: number): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const agent of agents) {
    if (agent.agent === "omp") continue;
    const state = agent.agent_status ?? "unknown";
    if (state === "unknown") continue;
    const status: ActivityStatus = state === "working" ? "working" : state === "blocked" ? "waiting" : "done";
    const where = agent.cwd === undefined ? "" : basename(agent.cwd);
    const title = (agent.terminal_title_stripped ?? agent.terminal_title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    out.push({
      id: `harness:${agent.pane_id}`,
      kind: "harness",
      owner: "other",
      title: title === "" ? where || agent.agent : title,
      status,
      intent: `${agent.agent}${where === "" ? "" : ` in ${where}`}${state === "idle" ? ", idle" : ""}`,
      startedAt: now,
      updatedAt: now,
      open: { to: "terminal", pane: agent.pane_id },
    });
  }
  return out;
}

/** Live canvas rooms are working; ended ones the host still lists are done. `cost` is the room's agent's spend, by slug. */
export function canvasItems(rooms: readonly CanvasRoomInfo[], cost: (slug: string) => number | undefined): ActivityItem[] {
  return rooms.map((room): ActivityItem => {
    const owner = room.chat.assistant !== undefined ? `assistant:${room.chat.assistant}` : room.chat.sessionId !== undefined ? `session:${room.chat.sessionId}` : "other";
    const spent = room.live ? cost(room.slug) : undefined;
    return {
      id: `canvas:${room.slug}`,
      kind: "canvas",
      owner,
      title: room.board === "" ? room.slug : room.board,
      status: room.live ? "working" : "done",
      intent: room.humans.length > 0 ? `${room.agent.name} with ${room.humans.join(", ")}` : `${room.agent.name} on the board`,
      startedAt: room.startedAt,
      updatedAt: room.endedAt ?? room.startedAt,
      ...(spent === undefined ? {} : { cost: spent }),
      open: { to: "canvas", slug: room.slug },
    };
  });
}
