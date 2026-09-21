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
      case "ack":
      case "nack":
      case "pong":
        // Session, command and agent traffic; owned by SessionMachine, CommandQueue and the
        // agent frame router.
        return;
    }
  };
}
