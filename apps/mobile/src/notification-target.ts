/**
 * Where a tapped notification leads, from its `data`: an assistant push (`assistant` + `agent`)
 * opens that agent's thread, a meeting push (`meeting`: "Recording ...", "Notes ready") that
 * meeting, a canvas invitation (`canvas`: the board's slug) that board's live room, a session
 * notification (`sessionId`) that session. Anything else (including an assistant push without an
 * agent, or a drop) leads nowhere. Kept free of expo modules so it is testable on its own.
 */
import type { Href } from "expo-router";

/**
 * An assistant's ring ("Nova is calling": `callRequest` + `agent`, the host's "call me when it's
 * done"), which a tap answers with a call rather than opening the thread; null for anything else.
 */
export function notificationCall(data: Record<string, unknown>): { agent: string; request: string } | null {
  const request = data["callRequest"];
  const agent = data["agent"];
  return typeof request === "string" && request !== "" && typeof agent === "string" && agent !== "" ? { agent, request } : null;
}

export function notificationTarget(data: Record<string, unknown>): Href | null {
  if (data["assistant"] === true) {
    const agent = data["agent"];
    return typeof agent === "string" && agent !== ""
      ? { pathname: "/eva", params: { agent } }
      : null;
  }
  const meeting = data["meeting"];
  if (typeof meeting === "string" && meeting !== "")
    return { pathname: "/meetings/[id]", params: { id: meeting } };
  const canvas = data["canvas"];
  if (typeof canvas === "string" && /^[a-z0-9-]{1,80}$/.test(canvas)) return { pathname: "/canvas", params: { slug: canvas } };
  const sessionId = data["sessionId"];
  return typeof sessionId === "string" ? { pathname: "/agents", params: { sessionId } } : null;
}
