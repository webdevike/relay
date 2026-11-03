/**
 * Background rows of an assistant thread: turns Isaac did not type (background jobs, heartbeats,
 * canvas notices, Relay Assist handoffs, tapbacks), read by the parser the desktop chat shares
 * (`@evaos/chat-core/background`). The host sends its own job lines as `status` rows and another
 * agent's hand-offs as `user` rows; either shows as a quiet centered row, never a bubble.
 * Pure, no React Native imports.
 */
import { parseBackground, type BackgroundMessage } from "@evaos/chat-core/background";
import type { AssistantMessage } from "@relay/protocol";

export type { BackgroundIcon, BackgroundMessage, HeartbeatItem } from "@evaos/chat-core/background";

/** What `message` is as a background row; null for Isaac's turns, the agent's replies and cards. */
export function backgroundOf(message: AssistantMessage): BackgroundMessage | null {
  return message.role === "user" || message.role === "status" ? parseBackground(message.text) : null;
}
