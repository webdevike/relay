/** Routes `usage.snapshot` into the usage store; the host answers `usage.get`/`usage.refresh` with it and pushes it on every refresh. */
import type { ServerMessage } from "@relay/protocol";
import type { UsageStore } from "@/state/usage";

export type UsageFrameRouter = (message: ServerMessage) => void;

export function createUsageFrameRouter(store: Pick<UsageStore, "set">): UsageFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "usage.snapshot") store.set(message.usage);
  };
}
