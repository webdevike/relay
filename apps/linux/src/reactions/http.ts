// `POST /reactions/agent` (JSON, loopback only, like `POST /assistant/say`) is how an assistant reacts
// to one of Isaac's bubbles in its own thread: `relay-linux react <emoji> [--agent <id>] [--message
// latest|<key>] [--clear]` from its session. Body `{ agent, emoji?, message?, clear? }`; `message`
// defaults to `latest`, Isaac's newest bubble in the thread. Answers `{ thread, message, emoji }`.
// Shown on every device; never a turn, a note or a push.

import { assistantReactionThread, ISAAC_REACTOR, ReactionEmoji, ReactionKey, reactionExcerpt, reactionKey, reactionRole } from "@relay/protocol";
import { z } from "zod";
import { isLoopback } from "../boards/http";
import type { AssistantRelaying } from "../seams";
import type { ReactionRelaying } from "./service";

const AgentReaction = z.object({
  agent: z.string().regex(/^[a-z][a-z0-9-]*$/),
  emoji: ReactionEmoji.optional(),
  message: z.union([z.literal("latest"), ReactionKey]).default("latest"),
  clear: z.boolean().default(false),
});

export async function handleAgentReaction(reactions: ReactionRelaying | null, assistant: AssistantRelaying | null, request: Request, remote: string): Promise<Response> {
  if (reactions === null || assistant === null) return new Response("reactions disabled", { status: 404 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("body must be JSON", { status: 400 });
  }
  const parsed = AgentReaction.safeParse(body);
  if (!parsed.success) return new Response(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), { status: 400 });
  const { agent, emoji, message, clear } = parsed.data;
  if (agent === ISAAC_REACTOR) return new Response("agents cannot react as Isaac", { status: 400 });
  if (!clear && emoji === undefined) return new Response("missing emoji (or --clear)", { status: 400 });
  const thread = assistant.thread(agent);
  if (thread === undefined) return new Response(`unknown agent ${agent}`, { status: 400 });
  const { messages } = await thread.snapshot();
  const target =
    message === "latest"
      ? messages.filter((row) => row.role === "user").at(-1)
      : messages.find((row) => row.role === reactionRole(message) && reactionKey(reactionRole(message), row.at) === message);
  if (target === undefined) return new Response(message === "latest" ? "no message from Isaac in the thread yet" : `no bubble ${message} in the thread`, { status: 404 });
  if (target.role !== "user") return new Response("agents react only to Isaac's messages", { status: 400 });
  const key = reactionKey("user", target.at);
  const id = assistantReactionThread(agent);
  if (clear) reactions.clear(id, key, agent);
  else reactions.set(id, key, emoji ?? "", reactionExcerpt(target.text), agent);
  return Response.json({ thread: id, message: key, emoji: clear ? null : (emoji ?? null) });
}
