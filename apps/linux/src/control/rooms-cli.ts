// `relay-linux rooms create|update|list`: an assistant on this Mac sets up a room in Relay Desktop
// from its conversation with Isaac. Each verb is the desktop agent action of the same name
// (rooms.create, rooms.update, rooms.list in @evaos/contract agent.ts), sent through the host's
// loopback `POST /control/run` to the desktop Isaac used last (or `--device`), with the caller's
// thread as the scope (`agent:$RELAY_ASSISTANT`), exactly like relay-ctl and relay-mcp. The
// desktop checks the params, the models and the limits for assistant-made rooms.

import type { ControlResult } from "@relay/protocol";

export const ROOMS_USAGE = `relay-linux rooms list
relay-linux rooms create '<json>'          (or - / nothing: the JSON on stdin)
relay-linux rooms update <roomId> '<json>' (or - / nothing: the JSON on stdin)
  create JSON: {"title"?, "members": [{"assistant": "<id>" | "custom": "<name>", "model": "<provider/id>",
    "thinking": "low", "role": "Critic", "instructions"?}], "effort": 1-5, "budget": <USD>, "folder"?, "refs"?,
    "draft"? (prefilled in the room, never sent), "proposal"? (a council Isaac convenes; draft = the question)}
  update JSON: any of those; "members" as a full list, or {"add": [...], "remove": ["<id or name>"],
    "replace": {"from": "<id or name>", "to": {...}}}
  --device <id or name>  the Mac to set it up on (default: the one Isaac used last)`;

export type RoomsVerb = "create" | "update" | "list";

/** The body `POST /control/run` takes (protocol ControlRequest). */
export interface RoomsControlBody {
  action: `rooms.${RoomsVerb}`;
  params: Record<string, unknown>;
  scope?: string;
  target?: string;
}

/** The `POST /control/run` body for `rooms <verb> ...`; throws a usage line when the arguments are off. */
export async function roomsControlRequest(options: {
  verb: string | undefined;
  args: readonly string[];
  /** The JSON from stdin, when the arguments leave it there. */
  stdin: () => Promise<string>;
  assistant: string | undefined;
  device: string | undefined;
}): Promise<RoomsControlBody> {
  const { verb, args } = options;
  if (verb !== "create" && verb !== "update" && verb !== "list") throw new Error(`rooms: try create, update or list\n\n${ROOMS_USAGE}`);
  const base = {
    action: `rooms.${verb}` as const,
    ...(options.assistant ? { scope: `agent:${options.assistant}` } : {}),
    ...(options.device ? { target: options.device } : {}),
  };
  if (verb === "list") return { ...base, params: {} };
  const roomId = verb === "update" ? args[0] : undefined;
  if (verb === "update" && (roomId === undefined || roomId === "-" || roomId.startsWith("{"))) throw new Error("rooms update: missing <roomId> (rooms list names them)");
  const rest = verb === "update" ? args.slice(1) : args;
  const raw = rest.length === 0 || rest[0] === "-" ? await options.stdin() : rest.join(" ");
  let params: unknown;
  try {
    params = JSON.parse(raw);
  } catch {
    throw new Error(`rooms ${verb}: the setup is not JSON\n\n${ROOMS_USAGE}`);
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error(`rooms ${verb}: the setup is a JSON object`);
  return { ...base, params: roomId === undefined ? { ...params } : { ...params, roomId } };
}

/** What the CLI prints for the desktop's answer: the value as JSON, then what to do with it. */
export function roomsOutput(action: RoomsControlBody["action"], result: ControlResult): { ok: boolean; lines: string[] } {
  if (!result.ok) return { ok: false, lines: [`${result.code}: ${result.message}`] };
  const value = result.value ?? null;
  const next = typeof value === "object" && value !== null && "next" in value ? value.next : undefined;
  const lines = [JSON.stringify(value, null, 2)];
  if (action === "rooms.create" && typeof next === "string") lines.push("", next);
  if (action === "rooms.update") lines.push("", "The room's card in your chat shows the change; do not post it again.");
  return { ok: true, lines };
}
