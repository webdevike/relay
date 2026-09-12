/**
 * Push notifications for sessions that wait on the user. The host decides when to notify (see
 * apps/linux/src/push/notifier.ts); the phone's job is the permission prompt, handing the host its
 * Expo push token on every connection while the setting is on, and opening the session a tapped
 * notification points at.
 */
import { useEffect } from "react";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { registerPush, unregisterPush } from "@/connection";
import { warn } from "@/connection/log";
import { useConnectionStore } from "@/state/connection";
import { useSettingsStore } from "@/state/settings";

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

function openSession(notification: Notifications.Notification): void {
  const sessionId: unknown = notification.request.content.data["sessionId"];
  if (typeof sessionId !== "string") return;
  router.navigate({ pathname: "/agents", params: { sessionId } });
}

/** Mounts at the root: re-registers on every connection and routes notification taps. */
export function usePushNotifications(): void {
  useEffect(() => {
    void syncRegistration();
    const unsubscribe = useConnectionStore.subscribe((next, prev) => {
      if (next.status === "connected" && prev.status !== "connected") void syncRegistration();
    });
    const launch = Notifications.getLastNotificationResponse();
    if (launch) openSession(launch.notification);
    const responses = Notifications.addNotificationResponseReceivedListener((response) => {
      openSession(response.notification);
    });
    return () => {
      unsubscribe();
      responses.remove();
    };
  }, []);
}
