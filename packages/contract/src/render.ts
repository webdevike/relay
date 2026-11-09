import { z } from 'zod'
import { ReactionKeySchema, ReactionThreadSchema } from '@evaos/chat-core/reactions'

/** What failed to show: mirrors the host's RenderKind (packages/protocol). */
export const RenderKindSchema = z.enum(['image', 'video', 'audio', 'model', 'gallery', 'compare'])
export type RenderKind = z.infer<typeof RenderKindSchema>
/** How the agent wrote it: a markdown embed, an openui block or a legacy ```ui widget. */
export const RenderFormSchema = z.enum(['markdown', 'openui', 'ui'])
export type RenderForm = z.infer<typeof RenderFormSchema>

export const MAX_RENDER_SRC = 2048
export const MAX_RENDER_ERROR = 300

export const renderInvoke = {
  /**
   * Media in bubble `message` of `thread` failed to show; main tells the host (when it takes
   * "render.report") so the owning agent can repost it in a form that works. Fire and forget:
   * `sent` is false when the host is down or too old.
   */
  'render.failed': {
    input: z
      .object({
        thread: ReactionThreadSchema,
        message: ReactionKeySchema,
        kind: RenderKindSchema,
        form: RenderFormSchema,
        src: z.string().min(1).max(MAX_RENDER_SRC),
        error: z.string().max(MAX_RENDER_ERROR),
      })
      .strict(),
    output: z.object({ sent: z.boolean() }),
  },
} as const
