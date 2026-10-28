/**
 * Routes the drop box server frames into the drops store. The host is the source of truth, so
 * there is no rev or gap handling here: `drop.list` replaces everything (asked on every welcome by
 * the driver) and `drop.new`/`drop.removed` are applied as they arrive.
 */
import type { ServerMessage } from "@relay/protocol";
import type { DropsStore } from "@/state/drops";

export type DropsStoreActions = Pick<DropsStore, "setAll" | "upsert" | "remove">;

export type DropFrameRouter = (message: ServerMessage) => void;

export function createDropFrameRouter(store: DropsStoreActions): DropFrameRouter {
  return (message) => {
    switch (message.t) {
      case "drop.list":
        store.setAll(message.drops);
        return;
      case "drop.new":
        store.upsert(message.drop);
        return;
      case "drop.removed":
        store.remove(message.id);
        return;
      case "welcome":
      case "challenge":
      case "unpaired":
      case "pair.pending":
      case "pair.ok":
      case "pair.failed":
      case "error":
      case "mac.state":
      case "agents.snapshot":
      case "agents.delta":
      case "agent.conversation":
      case "agent.messages":
      case "agent.message.update":
      case "agent.options":
      case "agent.image":
      case "agent.ask":
      case "agent.ask.resolved":
      case "agent.approval":
      case "agent.approval.resolved":
      case "inbox.item":
      case "inbox.resolve":
      case "board.snapshot":
      case "board.delta":
      case "gate.status":
      case "call.state":
      case "call.audio":
      case "call.flush":
      case "assistant.snapshot":
      case "assistant.agents":
      case "vnc.ticket":
      case "vnc.unavailable":
      case "canvas.rooms":
      case "canvas.access":
      case "canvas.unavailable":
      case "ack":
      case "nack":
      case "pong":
        // Session, command, agent, board, vnc and canvas traffic; owned by SessionMachine, CommandQueue
        // and the other routers.
        return;
    }
  };
}
