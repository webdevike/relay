/**
 * The lock-screen actions of an agent that is blocked on Isaac (mockup 06 of the notification
 * proposal). The host names a category in each push (`INBOX_CATEGORY`); iOS only shows actions for
 * categories the app registered, so these are set at every launch.
 *
 * - `relay.approval`: Approve acts from the lock screen with one tap (no unlock, no app launch).
 * - `relay.approval.biometric`: a destructive call. Approve opens the app, which asks for Face ID
 *   before it sends; there is no "always allow" in either category.
 * - `relay.ask`: a text field. Typing an option's label or number (or any other answer) answers the
 *   question in place. iOS fixes an action's title when the category is registered, so the options'
 *   own labels cannot be buttons here; the in-app card shows them.
 */
import * as Notifications from "expo-notifications";
import { INBOX_CATEGORY } from "@relay/protocol";
import { ACTION } from "./answer";

const open: Notifications.NotificationAction = {
  identifier: ACTION.open,
  buttonTitle: "Open in Relay",
  options: { opensAppToForeground: true },
};

const deny: Notifications.NotificationAction = {
  identifier: ACTION.deny,
  buttonTitle: "Deny",
  options: { isDestructive: true, opensAppToForeground: false, isAuthenticationRequired: false },
};

export async function registerInboxCategories(): Promise<void> {
  await Promise.all([
    Notifications.setNotificationCategoryAsync(INBOX_CATEGORY.approval, [
      { identifier: ACTION.approve, buttonTitle: "Approve", options: { opensAppToForeground: false, isAuthenticationRequired: false } },
      deny,
      open,
    ]),
    Notifications.setNotificationCategoryAsync(INBOX_CATEGORY.approvalBiometric, [
      { identifier: ACTION.approve, buttonTitle: "Approve with Face ID", options: { opensAppToForeground: true, isAuthenticationRequired: true } },
      deny,
      open,
    ]),
    Notifications.setNotificationCategoryAsync(INBOX_CATEGORY.ask, [
      {
        identifier: ACTION.answer,
        buttonTitle: "Answer",
        textInput: { submitButtonTitle: "Send", placeholder: "An option, its number, or your own answer" },
        options: { opensAppToForeground: false, isAuthenticationRequired: false },
      },
      open,
    ]),
  ]);
}
