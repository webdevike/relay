// `POST /assistant/say?agent=<id>` (text/plain, loopback only, like `POST /drops`) is how
// `relay-linux assistant say --agent <id>` and the host's jobs hand an assistant thread a message
// to relay to Isaac. A missing or unknown `agent` is a 400: job lines never fall back to a default.

import { isLoopback } from "../boards/http";
import type { AssistantRelaying } from "../seams";

/** Answers `POST /assistant/say`; `assistant` null (no threads on this host) is a 404. */
export async function handleAssistantSay(assistant: AssistantRelaying | null, request: Request, remote: string): Promise<Response> {
  if (assistant === null) return new Response("assistant disabled", { status: 404 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  const agent = new URL(request.url).searchParams.get("agent");
  if (agent === null || agent === "") return new Response("missing agent", { status: 400 });
  const thread = assistant.thread(agent);
  if (thread === undefined) return new Response(`unknown agent ${agent}`, { status: 400 });
  const text = (await request.text()).trim();
  if (text === "") return new Response("empty text", { status: 400 });
  try {
    await thread.say(text);
    return new Response("ok");
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 503 });
  }
}
