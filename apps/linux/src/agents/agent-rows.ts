// Specialist agents calls in transcript rows. The relay-bridge extension and the transcript reader keep an agents
// call raw on its row (`agentTool`: tool name, arguments, start, result), since they may not import zod or
// @relay/protocol (agents/transcript.ts). The host reads it here into the row's `agentRun` with the protocol's own
// `agentCallOf` / `agentRunOf`, at every boundary a row crosses (bridge frames, session files), and drops the raw call.

import { AgentMessage, AgentRun, agentCallOf, agentRunOf } from "@relay/protocol";
import { z } from "zod";
import type { AgentToolRaw } from "./transcript";

/** `AgentToolRaw` as a bridge frame carries it. */
export const AgentToolFrame = z.object({
  name: z.string().min(1),
  args: z.unknown(),
  startedAt: z.number(),
  result: z.object({ text: z.string(), isError: z.boolean() }).optional(),
});

/** The run a raw agents call shows now, or undefined when it is no agents call (or an `agents_result` still out). */
export function agentRunOfTool(tool: AgentToolRaw): AgentRun | undefined {
  const call = agentCallOf(tool.name, tool.args);
  if (call === undefined) return undefined;
  const parsed = AgentRun.safeParse(agentRunOf(call, tool.result, tool.startedAt));
  return parsed.success ? parsed.data : undefined;
}

/** A transcript row as the host passes it on: its raw agents call read into `agentRun`, never forwarded. */
export function agentMessageOf<T extends { agentTool?: AgentToolRaw | undefined }>(
  row: T,
): Omit<T, "agentTool"> & { agentRun?: AgentRun } {
  const { agentTool, ...rest } = row;
  const run = agentTool === undefined ? undefined : agentRunOfTool(agentTool);
  return run === undefined ? rest : { ...rest, agentRun: run };
}

/** An `AgentMessage` in a bridge frame, with the raw agents call the extension adds, read into `agentRun`. */
export const BridgeMessage = AgentMessage.extend({
  agentTool: AgentToolFrame.optional().catch(undefined),
}).transform(agentMessageOf);
