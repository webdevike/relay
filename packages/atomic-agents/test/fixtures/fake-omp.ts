#!/usr/bin/env bun
/**
 * A stand-in for `omp --mode rpc` that plays a scripted model (`FAKE_OMP_SCENARIO`, a JSON file of turns) over the
 * real RPC frames: `set_host_tools`, `prompt`, `host_tool_call` / `host_tool_result`, `message_update`, `message_end`,
 * `prompt_result`. Every inbound frame (and the argv, first) is appended to `FAKE_OMP_LOG` as JSON lines.
 *
 * A turn: `toolCalls` (each `{name, args}`; a string arg "$RESULTS" becomes the tool results so far, joined by " | "),
 * `text`, `stopReason`, `stream` (characters of text deltas sent before the message ends), `stall` (never ends).
 */
import { appendFileSync, readFileSync } from "node:fs"

interface Turn {
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>
  readonly text?: string
  readonly stopReason?: string
  readonly stream?: number
  readonly stall?: boolean
}

const turns: ReadonlyArray<Turn> = JSON.parse(readFileSync(process.env["FAKE_OMP_SCENARIO"]!, "utf8"))
const log = (entry: unknown) => appendFileSync(process.env["FAKE_OMP_LOG"]!, `${JSON.stringify(entry)}\n`)
const emit = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`)
log({ argv: process.argv.slice(2) })

const pending = new Map<string, (text: string) => void>()
const results: Array<string> = []
let next = 0

const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.001 } }

const play = async () => {
  for (const turn of turns) {
    emit({ type: "turn_start" })
    for (let sent = 0; sent < (turn.stream ?? 0); sent += 1000) {
      emit({ type: "message_update", messageId: "m", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x".repeat(1000) } })
      await Bun.sleep(1)
    }
    if (turn.stall === true) return await Promise.withResolvers<never>().promise
    const calls = (turn.toolCalls ?? []).map((call) => ({
      type: "toolCall",
      id: `toolu_${next++}`,
      name: call.name,
      arguments: Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, value === "$RESULTS" ? results.join(" | ") : value]))
    }))
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        stopReason: turn.stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
        content: [...(turn.text === undefined ? [] : [{ type: "text", text: turn.text }]), ...calls],
        usage
      }
    })
    const waits = calls.map((call) => {
      const id = `host_${call.id}`
      const { promise, resolve } = Promise.withResolvers<string>()
      pending.set(id, resolve)
      emit({ type: "host_tool_call", id, toolCallId: call.id, toolName: call.name, arguments: call.arguments })
      return promise
    })
    results.push(...(await Promise.all(waits)))
    if (calls.length === 0) break
  }
  emit({ type: "prompt_result", id: "prompt", agentInvoked: true, status: "completed", sessionSettled: true })
}

emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] })
let buffer = ""
for await (const chunk of process.stdin) {
  buffer += chunk.toString()
  for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
    const frame = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    log(frame)
    if (frame.type === "host_tool_result") pending.get(frame.id)?.(frame.result.content[0].text)
    else if (frame.type === "set_host_tools") emit({ id: frame.id, type: "response", command: frame.type, success: true, data: { toolNames: frame.tools.map((tool: { name: string }) => tool.name) } })
    else {
      emit({ id: frame.id, type: "response", command: frame.type, success: true })
      if (frame.type === "prompt") void play()
    }
  }
}
