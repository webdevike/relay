import { z } from 'zod'
import { CanvasAgentSchema, CanvasLiveSlugSchema } from '@evaos/chat-core/canvas-live'

/**
 * A canvas room the Relay host holds (live, or ended and still listed for its cards), hand-ported
 * from relay packages/protocol `CanvasRoomInfo`.
 */
export const CanvasRoomSchema = z.object({
  id: z.string().min(1),
  slug: CanvasLiveSlugSchema,
  board: z.string().max(400),
  live: z.boolean(),
  agent: CanvasAgentSchema,
  /** The chat the session came from: an omp session id and, for assistant threads, the assistant id. */
  chat: z.object({
    sessionId: z.string().optional(),
    assistant: z.string().optional(),
    title: z.string().max(400).optional(),
  }),
  /** Names of the humans in the room now. */
  humans: z.array(z.string().max(100)).max(50),
  startedAt: z.number(),
  endedAt: z.number().optional(),
})
export type CanvasRoom = z.infer<typeof CanvasRoomSchema>

export const CanvasRoomsSchema = z.object({
  /** Every room the host holds; empty while Relay is down. */
  rooms: z.array(CanvasRoomSchema).max(200),
  /** Relay is connected and has sent its rooms. */
  relayUp: z.boolean(),
  /** The host's http origin (`http://127.0.0.1:<port>`) for avatars, null without a Relay host. */
  origin: z.string().nullable(),
})
export type CanvasRooms = z.infer<typeof CanvasRoomsSchema>

export const canvasLiveInvoke = {
  'canvas.live.rooms': { input: z.object({}).strict(), output: CanvasRoomsSchema },
  /**
   * The URL of the live room on `slug` for this app's frame (a fresh token from the host). Fails
   * with `canvas-unavailable` (the host's one-line reason) when no room is live there.
   */
  'canvas.live.open': {
    input: z.object({ slug: CanvasLiveSlugSchema }).strict(),
    output: z.object({ url: z.string().startsWith('http://127.0.0.1:') }),
  },
  /**
   * Starts a live session on the board `slug` (what `relay-linux canvas start <slug>` does) and hands
   * it the comment thread already saved in the board file, so the comment gets answered. The
   * answerer is `assistant` (a registry id: the one an `@name` in the comment named), else Nova. With
   * a live room of another assistant on the board, that assistant joins it as a worker for the
   * thread. Fails with `canvas-unavailable` (the host's one-line reason) when the host refuses or is
   * not running.
   */
  'canvas.live.ask': {
    input: z
      .object({
        slug: CanvasLiveSlugSchema,
        thread: z.string().min(1).max(60),
        page: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
          .optional(),
        assistant: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(60)
          .optional(),
      })
      .strict(),
    output: z.object({ roomId: z.string().min(1), agent: z.string().min(1) }),
  },
} as const

export const canvasLiveEvents = {
  /** The host's rooms after any change, including Relay going down. */
  'canvas.live.changed': CanvasRoomsSchema,
} as const
