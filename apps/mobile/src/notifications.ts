/**
 * Push notifications for sessions that wait on the user and for host-origin drops. The host
 * decides when to notify (see apps/linux/src/push/notifier.ts and inbox/service.ts); the phone's
 * job is the permission prompt, handing the host its Expo push token on every connection while the
 * setting is on, registering the lock-screen actions of an agent blocked on Isaac (`@/inbox`),
 * and opening the session or drop box a tapped notification points at.
 */
import { useEffect } from "react";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { registerPush, unregisterPush } from "@/connection";
import { warn } from "@/connection/log";
import { useConnectionStore } from "@/state/connection";
import { useSettingsStore } from "@/state/settings";
import { registerWithdrawTask } from "@/inbox/background";
import { registerInboxCategories } from "@/inbox/categories";
import { respondToInbox } from "@/inbox/respond";

Notifications.setNotificationHandler({
  handleNotification: () => Promise.resolve({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** Fetched once per launch; Expo tokens are stable for an install. */
let token: string | null = null;

async function fetchToken(): Promise<string> {
  if (token !== null) return token;
  const eas: unknown = Constants.expoConfig?.extra?.["eas"];
  const projectId = typeof eas === "object" && eas !== null && "projectId" in eas ? eas.projectId : undefined;
  if (typeof projectId !== "string") throw new Error("no EAS projectId in app config");
  token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  return token;
}

/** Sends `push.register` when the setting is on and the socket is up; a no-op otherwise. */
async function syncRegistration(): Promise<void> {
  if (!useSettingsStore.getState().notificationsEnabled) return;
  if (useConnectionStore.getState().status !== "connected") return;
  try {
    registerPush(await fetchToken());
  } catch (error) {
    warn("push", "token unavailable", error);
  }
}

/**
 * Flips the setting. Turning it on asks for the system permission first and resolves `false`
 * (setting left off) when it is refused or no token can be obtained (simulator, no network).
 */
export async function setNotificationsEnabled(enabled: boolean): Promise<boolean> {
  const settings = useSettingsStore.getState();
  if (!enabled) {
    settings.set({ notificationsEnabled: false });
    unregisterPush();
    return true;
  }
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;
  try {
    await fetchToken();
  } catch (error) {
    warn("push", "token unavailable", error);
    return false;
  }
  settings.set({ notificationsEnabled: true });
  await syncRegistration();
  return true;
}

/** A session notification carries `sessionId`, a drop notification `dropId`; anything else is ignored. */
function openTarget(notification: Notifications.Notification): void {
  const data = notification.request.content.data;
  const dropId: unknown = data["dropId"];
  if (typeof dropId === "string") {
    router.navigate({ pathname: "/drops" });
    return;
  }
  const sessionId: unknown = data["sessionId"];
  if (typeof sessionId !== "string") return;
  router.navigate({ pathname: "/agents", params: { sessionId } });
}

/** An inbox action (Approve, Deny, an ask's answer) is answered in place; any other response opens what it points at. */
function route(response: Notifications.NotificationResponse): void {
  respondToInbox(response)
    .then((answered) => {
      if (!answered) openTarget(response.notification);
    })
    .catch((error: unknown) => {
      warn("push", "notification response failed", error);
    });
}

/** Mounts at the root: re-registers on every connection and routes notification taps and actions. */
export function usePushNotifications(): void {
  useEffect(() => {
    void syncRegistration();
    registerInboxCategories().catch((error: unknown) => {
      warn("push", "inbox actions unavailable", error);
    });
    registerWithdrawTask().catch((error: unknown) => {
      warn("push", "withdraw task unavailable", error);
    });
    const unsubscribe = useConnectionStore.subscribe((next, prev) => {
      if (next.status === "connected" && prev.status !== "connected") void syncRegistration();
    });
    // An action chosen while the app was not running arrives as the launch response.
    const launch = Notifications.getLastNotificationResponse();
    if (launch) route(launch);
    const responses = Notifications.addNotificationResponseReceivedListener(route);
    return () => {
      unsubscribe();
      responses.remove();
    };
  }, []);
}
