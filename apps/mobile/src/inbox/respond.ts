/**
 * Runs a lock-screen notification action on an inbox push: Approve, Deny, or the ask's text answer.
 * The app may have been woken in the background for just this (iOS gives a short window), so it
 * reconnects first, answers, and tells Isaac when it could not rather than failing silently.
 * What to do lives in `answer.ts`; this wires it to Face ID, the socket and the notification centre.
 */
import * as Notifications from "expo-notifications";
import { sendCommand, wakeConnection } from "@/connection";
import { warn } from "@/connection/log";
import { useConnectionStore } from "@/state/connection";
import { notifyHaptic } from "@/lib/haptics";
import { ACTION, answerFromNotification, parseInboxData, type AnswerDeps, type InboxNotificationData, type Outcome } from "./answer";
import { confirmWithBiometrics } from "./biometric";

/** How long a background wake waits for the host before giving up. */
const CONNECT_TIMEOUT_MS = 25_000;

/** Wakes the connection and resolves true once the host is reachable, false on timeout. */
export function whenConnected(timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  wakeConnection();
  if (useConnectionStore.getState().status === "connected") return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useConnectionStore.subscribe((state) => {
      if (state.status !== "connected") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

export const answerDeps: AnswerDeps = { authenticate: confirmWithBiometrics, whenConnected, send: sendCommand };

const handled = new Set<string>();

function failureText(outcome: Outcome, data: InboxNotificationData): string | null {
  const what = data.kind === "approval" ? "approve" : "answer";
  switch (outcome.status) {
    case "cancelled":
      return `Face ID didn't confirm, so nothing was approved. Open Relay to try again.`;
    case "offline":
      return `Relay couldn't reach your Mac to ${what}. The agent is still waiting.`;
    case "failed":
      return `Couldn't ${what}: ${outcome.message}. The agent is still waiting.`;
    case "sent":
    case "ignored":
      return null;
  }
}

/**
 * Handles `response` if it is an action on an inbox notification. Resolves true when it was (nothing
 * left to route), false for a plain tap, an `Open in Relay` or any other notification.
 */
export async function respondToInbox(response: Notifications.NotificationResponse): Promise<boolean> {
  const action = response.actionIdentifier;
  if (action === Notifications.DEFAULT_ACTION_IDENTIFIER || action === ACTION.open) return false;
  const request = response.notification.request;
  const data = parseInboxData(request.content.data);
  if (data === null) return false;
  // The same response reaches both the listener and the launch check.
  const key = `${request.identifier}/${action}/${response.notification.date}`;
  if (handled.has(key)) return true;
  handled.add(key);
  const outcome = await answerFromNotification(data, action, response.userText, answerDeps);
  if (outcome.status === "sent") {
    notifyHaptic("success");
    await Notifications.dismissNotificationAsync(request.identifier);
    return true;
  }
  const body = failureText(outcome, data);
  if (body !== null) {
    warn("inbox", "notification action did not complete", outcome.status);
    await Notifications.scheduleNotificationAsync({
      content: { title: data.kind === "approval" ? "Approval not sent" : "Answer not sent", body, data: { sessionId: data.sessionId } },
      trigger: null,
    });
  }
  return true;
}
