/**
 * Routes `assistant.agents` (the host's registry) and `assistant.snapshot` into the assistant
 * store. The host sends an agent's whole thread every time (on `assistant.get` and after each
 * change), so there is no gap handling: within one connection a snapshot older than the last one
 * applied for the same agent is ignored (two can cross on the wire), and a new welcome forgets
 * those revs because a restarted host counts from zero again. Each welcome also says whether the
 * host sends guest rows (ASSISTANT_GUESTS_FEATURE).
 */
import { ASSISTANT_GUESTS_FEATURE, type ServerMessage } from "@relay/protocol";
import type { AssistantStore } from "@/state/assistant";

export type AssistantStoreActions = Pick<AssistantStore, "set" | "setAgents" | "setGuests">;
export type AssistantFrameRouter = (message: ServerMessage) => void;

export function createAssistantFrameRouter(store: AssistantStoreActions): AssistantFrameRouter {
  const lastRev = new Map<string, number>();
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "welcome") {
      lastRev.clear();
      store.setGuests(message.features?.includes(ASSISTANT_GUESTS_FEATURE) === true);
      return;
    }
    if (message.t === "assistant.agents") {
      store.setAgents(message.agents);
      return;
    }
    if (message.t !== "assistant.snapshot") return;
    if (message.snapshot.rev < (lastRev.get(message.agent) ?? -1)) return;
    lastRev.set(message.agent, message.snapshot.rev);
    store.set(message.agent, message.snapshot);
  };
}
