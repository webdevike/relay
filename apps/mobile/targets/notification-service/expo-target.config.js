// Notification Service Extension: turns an assistant reply's push into a Communication
// Notification, so iOS shows it like a message from a person (Nova's portrait with a small Relay
// badge) instead of the app icon. Only pushes the host sends with `mutableContent` reach it.
// The avatar-<id>.png files are rendered from the agent registry by scripts/notification-avatars.ts.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = () => ({
  type: "notification-service",
  name: "NotificationService",
  displayName: "Relay Notifications",
  bundleIdentifier: ".notifications",
  deploymentTarget: "18.0",
  frameworks: ["UserNotifications", "Intents"],
});
