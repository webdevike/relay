import * as fs from 'node:fs'
import { noteText, ownerOfWorkspace, type AgentNote, type NoteOwner } from '@evaos/contract'
import type { ChatHandles } from '../chat'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'

/**
 * Isaac's notes on agent surfaces (a canvas comment, a mark on a web page) go into the chat that
 * owns the surface as his own message, so its assistant answers there and acts with its cursor
 * (docs/agent-presence.md).
 */

/** Sends a note to the chat owning its surface; `to` is the chat's name. */
export type SendNote = (
  note: AgentNote,
  workspace: string | null,
) => Promise<{ sent: boolean; to: string | null }>

export interface NoteDeps {
  chat: Pick<ChatHandles, 'post' | 'assistants'>
  /** The workspace of the chat whose agent works this surface now (its run), else null. */
  runWorkspace(note: AgentNote): string | null
}

/**
 * Who gets a note: the assistant a canvas comment @mentions, else the chat whose agent runs on
 * the surface, else the chat of the workspace it was left in. Null: no chat owns it.
 */
export function noteOwner(
  note: AgentNote,
  workspace: string | null,
  run: string | null,
  isAssistant: (id: string) => boolean,
): NoteOwner | null {
  if (note.surface === 'canvas' && note.assignee !== undefined && isAssistant(note.assignee)) {
    return { assistant: note.assignee }
  }
  return ownerOfWorkspace(run) ?? ownerOfWorkspace(workspace)
}

export function createSendNote(deps: NoteDeps): SendNote {
  return async (note, workspace) => {
    const isAssistant = (id: string): boolean =>
      deps.chat.assistants().agents.some((a) => a.id === id)
    const owner = noteOwner(note, workspace, deps.runWorkspace(note), isAssistant)
    if (owner === null) return { sent: false, to: null }
    // One per marked element or region: the note's schema bounds them at 8.
    const files =
      note.surface === 'browser' && 'file' in owner
        ? [note.image, ...(note.also ?? []).map((t) => t.image)].filter(
            (f): f is string => f !== undefined,
          )
        : []
    // A screenshot that went missing drops out; the text still names its path.
    const images = (
      await Promise.all(
        files.map((f) =>
          fs.promises
            .readFile(f)
            .then((b) => ({ mimeType: 'image/png', data: b.toString('base64') }))
            .catch(() => null),
        ),
      )
    ).filter((i) => i !== null)
    const to = await deps.chat.post(owner, noteText(note), images)
    return { sent: true, to }
  }
}

export interface AgentNotes {
  send: SendNote
  /** Tells notes which chat's agent runs on a surface (the drives register once they exist). */
  runsFrom(of: (note: AgentNote) => string | null): void
}

/** `agent.note` (the board's comments) and the sender the other surfaces use. */
export function registerAgentNotes(
  ctx: MainContext,
  chat: Pick<ChatHandles, 'post' | 'assistants'>,
): AgentNotes {
  let runs: (note: AgentNote) => string | null = () => null
  const send = createSendNote({ chat, runWorkspace: (note) => runs(note) })
  handle(ctx, 'agent.note', ({ note, workspace }) => send(note, workspace))
  return {
    send,
    runsFrom: (of) => {
      runs = of
    },
  }
}
