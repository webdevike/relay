// `POST /catchup/bounce` (JSON `{ id, agent, reason }`, loopback only, like `POST /assistant/say`) is
// how an assistant hands a Catch Up card back to Isaac: `.omp/tools/catchup.ts bounce <id> "<reason>"`,
// run from its thread, posts here. Same effect as a `catchup.bounce` frame.

import { AssistantAgentId, MAX_CATCHUP_NOTE } from "@relay/protocol";
import { z } from "zod";
import { isLoopback } from "../boards/http";
import type { CatchUpDeck } from "./service";

const BounceBody = z.object({
  id: z.string().min(1),
  agent: AssistantAgentId,
  reason: z.string().trim().min(1).max(MAX_CATCHUP_NOTE),
});

/** Answers `POST /catchup/bounce`; `deck` null (no feed on this host) is a 404, an unknown id a 404 too. */
export async function handleCatchUpBounce(deck: CatchUpDeck | null, request: Request, remote: string): Promise<Response> {
  if (deck === null) return new Response("catch up disabled", { status: 404 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!isLoopback(remote)) return new Response("loopback only", { status: 403 });
  let body: z.infer<typeof BounceBody>;
  try {
    const parsed = BounceBody.safeParse(await request.json());
    if (!parsed.success) return new Response(parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "), { status: 400 });
    body = parsed.data;
  } catch {
    return new Response("expected JSON { id, agent, reason }", { status: 400 });
  }
  if (!deck.bounce(body.id, body.agent, body.reason)) return new Response(`unknown item ${body.id}`, { status: 404 });
  return new Response("ok");
}
