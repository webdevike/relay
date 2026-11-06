import { z } from 'zod'
import { JEV_MODEL, JEV_URL } from '../rooms/jev'
import { DEFAULT_MODEL } from './brain'

/**
 * The two quick questions a walkthrough asks over and over: which control is this step about, and
 * does the window show the step done? Jev (TypeSafe System One, ~0.2 s, the rooms client's API)
 * when its key is there, else one small model call each.
 */
export interface Judge {
  readonly name: string
  /** The option key that best answers `question` (`none` when nothing fits) and its probability. */
  pick(
    question: string,
    title: string,
    options: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ choice: string; p: number }>
  /** Probability that `statement` holds for the window. */
  holds(statement: string, title: string, tree: string, signal?: AbortSignal): Promise<number>
}

const JevAnswers = z.object({
  answers: z.record(
    z.string(),
    z.object({
      choice: z.string().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
      noul: z.number().optional(),
    }),
  ),
})

export class JevJudge implements Judge {
  readonly name = 'jev'
  constructor(private key: string) {}

  private async ask(state: unknown, questions: Record<string, unknown>, signal?: AbortSignal) {
    const res = await fetch(JEV_URL, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    })
    if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return JevAnswers.parse(await res.json()).answers
  }

  async pick(
    question: string,
    title: string,
    options: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const a = await this.ask(
      { question, window: { title } },
      { target: { type: 'choice', instructions: question, criteria: options } },
      signal,
    )
    const choice = a.target?.choice ?? 'none'
    return { choice, p: a.target?.probabilities?.[choice] ?? 0 }
  }

  async holds(statement: string, title: string, tree: string, signal?: AbortSignal) {
    const a = await this.ask(
      { statement, window: { title, accessibility_tree: tree } },
      {
        yes: {
          type: 'noul',
          instructions:
            'Read `window` only. Is `statement` true of the window right now? Judge from labels and values (a field shows its value, a switch says on or off).',
        },
      },
      signal,
    )
    return a.yes?.noul ?? 0
  }
}

const ModelOut = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
})

/** Without Jev: the same questions as one structured model call each. */
export class ModelJudge implements Judge {
  readonly name = 'model'
  constructor(
    private key: string,
    private model = process.env.RELAY_COMPUTER_MODEL ?? DEFAULT_MODEL,
  ) {}

  private async json(
    prompt: string,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        reasoning: { effort: 'low' },
        input: prompt,
        text: { format: { type: 'json_schema', name: 'answer', strict: true, schema } },
      }),
    })
    if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const out = ModelOut.parse(await res.json())
    const text = out.output.flatMap((o) => o.content ?? []).find((c) => c.text)?.text ?? '{}'
    return JSON.parse(text) as unknown
  }

  async pick(
    question: string,
    title: string,
    options: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const keys = Object.keys(options)
    const list = keys.map((k) => `${k}: ${options[k]}`).join('\n')
    const r = z
      .object({ choice: z.string() })
      .parse(
        await this.json(
          `${question}\nWindow: ${title}\nOptions:\n${list}\nAnswer with the option key.`,
          {
            type: 'object',
            properties: { choice: { type: 'string', enum: keys } },
            required: ['choice'],
            additionalProperties: false,
          },
          signal,
        ),
      )
    return { choice: r.choice, p: 0.9 }
  }

  async holds(statement: string, title: string, tree: string, signal?: AbortSignal) {
    const r = z
      .object({ holds: z.boolean() })
      .parse(
        await this.json(
          `Window "${title}", accessibility tree:\n${tree.slice(0, 12_000)}\n\nIs this true of the window right now: ${statement}`,
          {
            type: 'object',
            properties: { holds: { type: 'boolean' } },
            required: ['holds'],
            additionalProperties: false,
          },
          signal,
        ),
      )
    return r.holds ? 0.95 : 0.05
  }
}
