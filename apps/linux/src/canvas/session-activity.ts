// What an omp session behind a room seat is doing right now, as the short status line the room's
// bar shows ("running a command…", "waiting on your approval"). A worker, and the chat the canvas
// self belongs to, do most of their work off the board in their own omp session; the bridge
// already reports that session's status and the tool it runs, so the room reads it from there
// instead of showing an idle agent that is in fact busy.
import type { AgentSession } from "@relay/protocol";
import { statusLine } from "./agent";

/** The status line for `session`, or null when it is idle, ended or unknown. */
export function sessionActivity(session: Pick<AgentSession, "status" | "statusDetail"> | undefined): string | null {
  if (session === undefined) return null;
  switch (session.status) {
    case "working":
      return session.statusDetail === undefined ? "thinking…" : statusLine(session.statusDetail, "");
    case "needs_permission":
      return "waiting on an approval…";
    case "waiting":
      return "waiting on an answer…";
    default:
      return null;
  }
}
