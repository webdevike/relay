import { z } from 'zod'
import { computerModels } from './brain'

/**
 * The vision fallback's eyes: where in a window's picture is the thing a step names, when the
 * window has no accessible control for it (custom-drawn apps such as Bambu Studio). One small
 * model call with the picture; the answer is a box in the picture's pixels and what it shows
 * there, which the safety gate reads like a control's label.
 */
export interface Located {
  /** Top-left corner and size of the box, in the picture's pixels. */
  x: number
  y: number
  w: number
  h: number
  /** The text or icon at that spot, as seen ("Print plate"). */
  label: string
}

export interface Locator {
  /** The box of `target` in `image` (`width` x `height` pixels), or null when it is not there. */
  locate(
    image: Buffer,
    size: { width: number; height: number },
    target: string,
    signal?: AbortSignal,
  ): Promise<Located | null>
}

const Answer = z.object({
  found: z.boolean(),
  label: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})

const ModelOut = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
})

/** A box the model answered, kept only when it is inside the picture and has a size. */
export function boxIn(
  a: z.infer<typeof Answer>,
  size: { width: number; height: number },
): Located | null {
  if (!a.found || a.w < 2 || a.h < 2) return null
  const cx = a.x + a.w / 2
  const cy = a.y + a.h / 2
  if (cx < 0 || cy < 0 || cx > size.width || cy > size.height) return null
  return { x: a.x, y: a.y, w: a.w, h: a.h, label: a.label.trim() }
}

export class ModelLocator implements Locator {
  constructor(
    private key: string,
    private use: { model: string; effort: string } = computerModels(null).step,
  ) {}

  async locate(
    image: Buffer,
    size: { width: number; height: number },
    target: string,
    signal?: AbortSignal,
  ): Promise<Located | null> {
    const prompt = [
      `This is a screenshot of one Mac window, ${size.width} x ${size.height} pixels, origin at the top-left corner.`,
      `Find the control described as: "${target}".`,
      'Answer the tight bounding box of that control in these pixels (x, y = its top-left corner, w, h = its size) and `label`: the exact text it shows, or a short name of its icon when it has no text.',
      'found = false when nothing on screen matches; never guess a different control.',
    ].join('\n')
    const res = await fetch(
      `${process.env.RELAY_COMPUTER_API_BASE ?? 'https://api.openai.com/v1'}/responses`,
      {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.use.model,
          reasoning: { effort: this.use.effort },
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: prompt },
                {
                  type: 'input_image',
                  image_url: `data:image/png;base64,${image.toString('base64')}`,
                  detail: 'high',
                },
              ],
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'located',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  found: { type: 'boolean' },
                  label: { type: 'string' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  w: { type: 'number' },
                  h: { type: 'number' },
                },
                required: ['found', 'label', 'x', 'y', 'w', 'h'],
                additionalProperties: false,
              },
            },
          },
        }),
      },
    )
    if (!res.ok) throw new Error(`locate ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const out = ModelOut.parse(await res.json())
    const text = out.output.flatMap((o) => o.content ?? []).find((c) => c.text)?.text ?? '{}'
    return boxIn(Answer.parse(JSON.parse(text)), size)
  }
}
