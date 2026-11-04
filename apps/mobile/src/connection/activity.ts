/** Routes `activity.snapshot` into the activity store; the host answers `activity.get` with it and pushes it after every change. */
import type { ServerMessage } from "@relay/protocol";
import type { ActivityStore } from "@/state/activity";

export type ActivityFrameRouter = (message: ServerMessage) => void;

export function createActivityFrameRouter(store: Pick<ActivityStore, "set">): ActivityFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "activity.snapshot") store.set(message.items);
  };
}
