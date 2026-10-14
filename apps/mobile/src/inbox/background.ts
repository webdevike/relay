/**
 * A silent push (`{ withdraw: <item id> }`, content-available) wakes the app in the background and
 * removes the delivered notification, so answering on the Mac or in the chat also clears the phone
 * when Relay is not running. While the app is connected, `inbox.resolve` does the same over the
 * socket (`connection/index.ts`). Defined at module scope: expo-task-manager needs the task
 * registered before the app finishes launching.
 */
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { warn } from "@/connection/log";
import { withdrawIdOf } from "./answer";
import { withdrawNotification } from "./withdraw";

const TASK = "relay.inbox.withdraw";

TaskManager.defineTask(TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody) => {
  if (error !== null) {
    warn("inbox", "withdraw task failed", error);
    return;
  }
  const id = withdrawIdOf(data);
  if (id !== null) await withdrawNotification(id);
});

export async function registerWithdrawTask(): Promise<void> {
  await Notifications.registerTaskAsync(TASK);
}
