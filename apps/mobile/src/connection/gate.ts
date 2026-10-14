/** Routes `gate.status` into the gate store; the host pushes it on every change and answers `gate.get`. */
import type { ServerMessage } from "@relay/protocol";
import type { GateStore } from "@/state/gate";

export type GateFrameRouter = (message: ServerMessage) => void;

export function createGateFrameRouter(store: Pick<GateStore, "set">): GateFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "gate.status") store.set(message.gate);
  };
}
