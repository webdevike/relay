import * as Notifications from "expo-notifications";

/** Removes the delivered notification for inbox item `id`, if one is on the lock screen or in the list. */
export async function withdrawNotification(id: string): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter((notification) => notification.request.content.data["id"] === id)
      .map((notification) => Notifications.dismissNotificationAsync(notification.request.identifier)),
  );
}
