import { z } from 'zod'

/**
 * A picture or video in a chat as the renderer shows it: its `relay-media://media/?src=<src>` URL
 * (a Relay drop, an http(s) URL, a local media file; main resolves it the way the scheme does) or
 * an image's `data:` URL (an image pasted into a message). Nothing else: main never fetches an
 * arbitrary URL or reads an arbitrary file for it.
 */
export const MediaRefSchema = z
  .string()
  .min(1)
  .max(60_000_000)
  .regex(/^(?:relay-media:\/\/media\/\?|data:image\/(?:png|jpeg|gif|webp);base64,)/)

export const mediaInvoke = {
  /**
   * Save Image As / Save Video As: the save dialog opens in Downloads with a name from `name` (a
   * caption) or the source, then the file is copied there. `path` is null when Isaac cancels.
   */
  'media.save': {
    input: z.object({ src: MediaRefSchema, name: z.string().max(500).optional() }).strict(),
    output: z.object({ path: z.string().nullable() }),
  },
  /** Copy Image (`image`, its pixels) or Copy Image/Video Address (`address`) to the clipboard. */
  'media.copy': {
    input: z.object({ src: MediaRefSchema, what: z.enum(['image', 'address']) }).strict(),
    output: z.object({ copied: z.literal(true) }),
  },
} as const
