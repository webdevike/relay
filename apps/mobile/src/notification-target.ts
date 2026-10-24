/**
 * Where a tapped notification leads, from its `data`: an assistant push (`assistant` + `agent`)
 * opens that agent's thread, a session notification (`sessionId`) that session. Anything else
 * (including an assistant push without an agent, or a drop) leads nowhere. Kept free of expo
 * modules so it is testable on its own.
 */
import type { Href } from "expo-router";

export function notificationTarget(data: Record<string, unknown>): Href | null {
  if (data["assistant"] === true) {
    const agent = data["agent"];
    return typeof agent === "string" && agent !== "" ? { pathname: "/eva", params: { agent } } : null;
  }
  const sessionId = data["sessionId"];
  return typeof sessionId === "string" ? { pathname: "/agents", params: { sessionId } } : null;
}
