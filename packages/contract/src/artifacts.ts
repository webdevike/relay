import { z } from 'zod'
import { Artifact, ArtifactAction, ArtifactTab, ArtifactThread } from '@evaos/chat-core/artifacts'

/** A thread's artifacts as the panel shows them, and whether Relay can take a change now. */
export const ArtifactsViewSchema = z.object({
  /** The thread (`assistant:<id>` or `session:<id>`); null for a chat without a session yet. */
  thread: ArtifactThread.nullable(),
  /** Relay is connected, so an action can be sent. */
  up: z.boolean(),
  /** False until the host's first snapshot of the thread arrives. */
  loaded: z.boolean(),
  items: z.array(Artifact),
  /** In bar order, hidden ones included. */
  tabs: z.array(ArtifactTab),
})
export type ArtifactsView = z.infer<typeof ArtifactsViewSchema>

/** The host's answer to one action; `error` is its refusal, verbatim; `id` a new item's or tab's. */
export const ArtifactsActedSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  id: z.string().optional(),
})
export type ArtifactsActed = z.infer<typeof ArtifactsActedSchema>

export const artifactsInvoke = {
  /**
   * Follows the artifacts of the chat in `file` (an assistant page names its `agent`): resolves its
   * thread, asks Relay for them now and after every reconnect, until `artifacts.unwatch`.
   */
  'artifacts.watch': {
    input: z.object({ file: z.string().max(4096), agent: z.string().max(128).nullable() }).strict(),
    output: ArtifactsViewSchema,
  },
  'artifacts.unwatch': {
    input: z.object({ thread: ArtifactThread }).strict(),
    output: z.object({}),
  },
  /** Does `action` on `thread` as Isaac; resolves with the host's answer. */
  'artifacts.act': {
    input: z.object({ thread: ArtifactThread, action: ArtifactAction }).strict(),
    output: ArtifactsActedSchema,
  },
  /** Opens an http(s) link in the default browser (a ticket in Linear, a PR on GitHub). */
  'artifacts.openExternal': {
    input: z.object({ url: z.string().url().max(2048) }).strict(),
    output: z.object({ opened: z.boolean() }),
  },
} as const

export const artifactsEvents = {
  /** A watched thread's artifacts as the host's latest snapshot has them. */
  'artifacts.changed': ArtifactsViewSchema.extend({ thread: ArtifactThread }),
  /** Relay came up or went down: a panel whose thread was resolved without it resolves it again. */
  'artifacts.status': z.object({ up: z.boolean() }),
} as const
