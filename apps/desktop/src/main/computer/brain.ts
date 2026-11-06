import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

/**
 * The `@computer` model: OpenAI's Responses API with function tools, the same API and default
 * model Relay Assist uses (`gpt-6.1-terra`). Planning thinks harder (medium effort) than the
 * per-step loop (low), so each step stays fast. The conversation is kept server side
 * (`previous_response_id`), so each turn sends only the new items.
 */

export interface ToolCall {
  callId: string
  name: string
  args: unknown
}

export interface Turn {
  calls: ToolCall[]
  text: string
}

export type InputItem =
  | {
      role: 'user'
      content: Array<
        { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }
      >
    }
  | { type: 'function_call_output'; call_id: string; output: string }

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Brain {
  turn(items: InputItem[], signal?: AbortSignal): Promise<Turn>
}

export const DEFAULT_MODEL = 'gpt-6.1-terra'

/** Which model and effort each part of a run uses. */
export interface ComputerModels {
  /** The per-step loop (headless, live) and the walk's judge fallback. */
  step: { model: string; effort: string }
  /** The plan written from the chat when the assistant's own session does not write it. */
  plan: { model: string; effort: string }
}

const ModelsFileSchema = z
  .object({
    model: z.string().min(1).optional().catch(undefined),
    effort: z.string().min(1).optional().catch(undefined),
    planModel: z.string().min(1).optional().catch(undefined),
    planEffort: z.string().min(1).optional().catch(undefined),
  })
  .catch({})

/**
 * The run's models: `RELAY_COMPUTER_MODEL` / `_EFFORT` / `_PLAN_MODEL` / `_PLAN_EFFORT`, else
 * `<config>/computer.json` (`{"model", "effort", "planModel", "planEffort"}`), else terra at low
 * effort for steps and medium for the plan (the plan model defaults to the step model).
 */
export function computerModels(
  file: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ComputerModels {
  const f = ModelsFileSchema.parse(file ?? {})
  const model = env.RELAY_COMPUTER_MODEL || f.model || DEFAULT_MODEL
  return {
    step: { model, effort: env.RELAY_COMPUTER_EFFORT || f.effort || 'low' },
    plan: {
      model: env.RELAY_COMPUTER_PLAN_MODEL || f.planModel || model,
      effort: env.RELAY_COMPUTER_PLAN_EFFORT || f.planEffort || 'medium',
    },
  }
}

/** `OPENAI_API_KEY`, else `<Eva>/secrets/openai.env` (Assist's file); null when neither has it. */
export function readOpenAIKey(
  evaRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY
  try {
    const m = /^(?:export\s+)?OPENAI_API_KEY=["']?([^"'\n]+)/m.exec(
      fs.readFileSync(path.join(evaRoot, 'secrets/openai.env'), 'utf8'),
    )
    return m ? m[1]!.trim() : null
  } catch {
    return null
  }
}

const OutputSchema = z.object({
  id: z.string(),
  output: z.array(
    z.object({
      type: z.string(),
      call_id: z.string().optional(),
      name: z.string().optional(),
      arguments: z.string().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
})

export class OpenAIBrain implements Brain {
  private previous: string | null = null

  constructor(
    private key: string,
    private instructions: string,
    private tools: readonly ToolSpec[],
    private use: { model: string; effort: string } = computerModels(null).step,
  ) {}

  async turn(items: InputItem[], signal?: AbortSignal): Promise<Turn> {
    const res = await fetch(
      `${process.env.RELAY_COMPUTER_API_BASE ?? 'https://api.openai.com/v1'}/responses`,
      {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.use.model,
          reasoning: { effort: this.use.effort },
          instructions: this.instructions,
          input: items,
          tools: this.tools.map((t) => ({ type: 'function', strict: false, ...t })),
          parallel_tool_calls: false,
          ...(this.previous ? { previous_response_id: this.previous } : {}),
        }),
      },
    )
    if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const out = OutputSchema.parse(await res.json())
    this.previous = out.id
    const calls: ToolCall[] = []
    const text: string[] = []
    for (const item of out.output) {
      if (item.type === 'function_call' && item.call_id && item.name) {
        let args: unknown = {}
        try {
          args = JSON.parse(item.arguments ?? '{}')
        } catch {
          args = {}
        }
        calls.push({ callId: item.call_id, name: item.name, args })
      } else if (item.type === 'message') {
        for (const c of item.content ?? []) if (c.text) text.push(c.text)
      }
    }
    return { calls, text: text.join('\n').trim() }
  }
}
