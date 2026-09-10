/**
 * Routes the coding-agent server frames into the agents store. Pure apart from the injected
 * store and `send`, so the gap handling is testable without a socket: a session-list gap asks
 * for a fresh `agents.snapshot`, a conversation gap re-subscribes. Each recovery is requested
 * once and not repeated until the host's answer lands, so a burst of stale frames cannot fan out
 * into a burst of requests.
 */
import type { ClientMessage, ServerMessage } from "@relay/protocol";
import type { AgentsStore } from "@/state/agents";

export type AgentsStoreActions = Pick<AgentsStore, "applyWelcome" | "applySnapshot" | "applyDelta" | "setConversation" | "appendMessages" | "setOptions">;

export type AgentFrameRouter = (message: ServerMessage) => void;

export function createAgentFrameRouter(store: AgentsStoreActions, send: (message: ClientMessage) => void): AgentFrameRouter {
  let snapshotRequested = false;
  const resubscribing = new Set<string>();

  const resubscribe = (sessionId: string): void => {
    if (resubscribing.has(sessionId)) return;
    resubscribing.add(sessionId);
    send({ t: "agent.unsubscribe", sessionId });
    send({ t: "agent.subscribe", sessionId });
  };

  return (message) => {
    switch (message.t) {
      case "welcome":
        snapshotRequested = false;
        resubscribing.clear();
        store.applyWelcome(message.state.agents.rev, message.state.agents.sessions);
        return;
      case "agents.snapshot":
        snapshotRequested = false;
        store.applySnapshot(message.rev, message.sessions);
        return;
      case "agents.delta":
        if (store.applyDelta(message.rev, message.upsert, message.remove) || snapshotRequested) return;
        snapshotRequested = true;
        send({ t: "agents.get" });
        return;
      case "agent.conversation":
        resubscribing.delete(message.sessionId);
        store.setConversation(message.sessionId, message.rev, message.messages);
        return;
      case "agent.messages":
        if (store.appendMessages(message.sessionId, message.rev, message.append)) return;
        resubscribe(message.sessionId);
        return;
      case "agent.options":
        store.setOptions(message.sessionId, { models: message.models, skills: message.skills });
        return;
      case "challenge":
      case "unpaired":
      case "pair.pending":
      case "pair.ok":
      case "pair.failed":
      case "error":
      case "mac.state":
      case "ack":
      case "nack":
      case "pong":
        // Session and command traffic; owned by SessionMachine and CommandQueue.
        return;
    }
  };
}
