// Live presence in the Files editor, main's side (relay packages/protocol `files.*` frames): the
// renderer's open text tabs and Isaac's caret go to the Relay Host as absolute host paths; the
// host's `files.edit` (an agent wrote an open file) and `files.presence` (Isaac's caret on his
// other devices) come back to the renderer as tabs (root and relative path) and portrait URLs.
// Only a host whose welcome lists "files.presence" hears any of it: an older host drops a
// connection over a frame it does not know.
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { z } from 'zod'
import type { PresenceEdit, PresenceFocus } from '@evaos/contract'
import type { RelayFrames } from '../relay/client'

export const FILES_PRESENCE_FEATURE = 'files.presence'

export interface Target {
  root: string
  path: string
}

export interface FocusInput extends Target {
  caret: { line: number; column: number }
  selection?: { start: { line: number; column: number }; end: { line: number; column: number } }
  selectedText?: string
}

export interface FilesPresenceDeps {
  frames: RelayFrames
  /** Where a tab's file is on the host; null when the host cannot see it (a thin client's own disk). */
  hostPathOf: (root: string, rel: string) => string | null
  /** The host's http origin, for agent portraits (`/canvas/avatar/<id>`). */
  origin: () => string | null
  emitEdit: (edit: PresenceEdit) => void
  emitFocus: (focus: PresenceFocus[]) => void
}

export interface FilesPresence {
  open(files: readonly Target[]): void
  caret(focus: FocusInput | null): void
  /** Isaac's editor is about to write `text` to this tab: that write is not an agent's. */
  noteSave(root: string, rel: string, text: string): void
  stop(): void
}

const Pos = z.object({ line: z.number().int().positive(), column: z.number().int().positive() })
const EditFrame = z.object({
  path: z.string().min(1),
  hash: z.string().min(1).max(128),
  ranges: z
    .array(
      z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }),
    )
    .max(50),
  caret: Pos,
  agent: z.object({
    name: z.string().min(1).max(200),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    avatar: z.string().max(300).optional(),
  }),
  intent: z.string().max(300).optional(),
  at: z.number(),
})
const PresenceFrame = z.object({
  focus: z
    .array(
      z.object({
        device: z.string().min(1).max(200),
        deviceName: z.string().max(200),
        path: z.string().min(1).max(4096),
        caret: Pos,
        selection: z.object({ start: Pos, end: Pos }).optional(),
        selectedText: z.string().max(2000).optional(),
        at: z.number(),
      }),
    )
    .max(20),
})

/** On the Mini a tab's file is the host's own file; on a thin client only host-backed roots have one. */
export function localHostPath(remote: boolean): (root: string, rel: string) => string | null {
  return (root, rel) => (remote ? null : path.join(root, rel))
}

export function createFilesPresence(deps: FilesPresenceDeps): FilesPresence {
  let enabled = false
  /** Host path -> the tabs that show it. */
  let open = new Map<string, Target[]>()
  let focus: {
    path: string
    caret: FocusInput['caret']
    selection?: FocusInput['selection']
    selectedText?: string
  } | null = null
  let sentFocus = 'null'

  const send = (frame: Record<string, unknown>): void => {
    if (enabled) deps.frames.sendFrame(frame)
  }
  const sendOpen = (): void => send({ t: 'files.open', paths: [...open.keys()] })
  const sendFocus = (): void => {
    const key = JSON.stringify(focus)
    if (key === sentFocus) return
    sentFocus = key
    send({ t: 'files.caret', focus })
  }

  const off = deps.frames.onFrame((f) => {
    if (f.t === 'welcome') {
      // A new connection: say it all again (the host forgot this socket's files and caret).
      enabled = Array.isArray(f.features) && f.features.includes(FILES_PRESENCE_FEATURE)
      sentFocus = 'null'
      sendOpen()
      sendFocus()
      return
    }
    if (f.t === 'files.edit') {
      const e = EditFrame.safeParse(f)
      if (!e.success) return
      const targets = open.get(e.data.path)
      if (!targets) return
      const { avatar, ...agent } = e.data.agent
      const origin = deps.origin()
      deps.emitEdit({
        targets,
        hash: e.data.hash,
        ranges: e.data.ranges,
        caret: e.data.caret,
        agent: { ...agent, ...(avatar && origin ? { avatarUrl: `${origin}${avatar}` } : {}) },
        ...(e.data.intent ? { intent: e.data.intent } : {}),
        at: e.data.at,
      })
      return
    }
    if (f.t === 'files.presence') {
      const p = PresenceFrame.safeParse(f)
      if (p.success) deps.emitFocus(p.data.focus)
    }
  })

  return {
    open(files) {
      const next = new Map<string, Target[]>()
      for (const t of files) {
        const host = deps.hostPathOf(t.root, t.path)
        if (host === null) continue
        next.set(host, [...(next.get(host) ?? []), { root: t.root, path: t.path }])
      }
      const changed = next.size !== open.size || [...next.keys()].some((k) => !open.has(k))
      open = next
      if (changed) sendOpen()
    },
    caret(input) {
      const host = input === null ? null : deps.hostPathOf(input.root, input.path)
      focus =
        input === null || host === null
          ? null
          : {
              path: host,
              caret: input.caret,
              ...(input.selection ? { selection: input.selection } : {}),
              ...(input.selectedText ? { selectedText: input.selectedText } : {}),
            }
      sendFocus()
    },
    noteSave(root, rel, text) {
      const host = deps.hostPathOf(root, rel)
      if (host === null) return
      send({
        t: 'files.saved',
        path: host,
        hash: createHash('sha1').update(text, 'utf8').digest('hex'),
      })
    },
    stop: off,
  }
}
