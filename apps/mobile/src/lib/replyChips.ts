/**
 * Which tap-to-answer replies an assistant thread shows (`AssistantMessage.replies`, cut by the host
 * from a reply's `[[replies: a | b]]` token). Only the newest shown row may carry them, and only once
 * it has settled: the thread is not working (so the reply is not streaming and no next one is on its
 * way) and no turn of Isaac's is waiting to land. Older turns never show any.
 * Pure, no React Native imports.
 */
import type { AssistantSnapshot } from "@relay/protocol";

/** The replies to show under the newest row of `snapshot`, or null; `sending`: a turn of Isaac's is still waiting to land. */
export function liveReplies(snapshot: AssistantSnapshot | null, sending: boolean): readonly string[] | null {
  if (snapshot === null || snapshot.busy || sending) return null;
  // Status rows are machinery the thread never shows, so the newest row is the newest other one.
  for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
    const message = snapshot.messages[i];
    if (message === undefined || message.role === "status") continue;
    return message.role === "assistant" && message.replies !== undefined && message.replies.length >= 2 ? message.replies : null;
  }
  return null;
}
