/**
 * Routes `assistant.snapshot` into the assistant store. The host sends the whole thread every
 * time (on `assistant.get` and after each change), so there is no gap handling: within one
 * connection a snapshot older than the last one applied is ignored (two can cross on the wire),
 * and a new welcome forgets that rev because a restarted host counts from zero again.
 */
import type { ServerMessage } from "@relay/protocol";
import type { AssistantStore } from "@/state/assistant";

export type AssistantStoreActions = Pick<AssistantStore, "set">;

export type AssistantFrameRouter = (message: ServerMessage) => void;

export function createAssistantFrameRouter(store: AssistantStoreActions): AssistantFrameRouter {
  let lastRev = -1;
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "welcome") {
      lastRev = -1;
      return;
    }
    if (message.t !== "assistant.snapshot") return;
    if (message.snapshot.rev < lastRev) return;
    lastRev = message.snapshot.rev;
    store.set(message.snapshot);
  };
}
