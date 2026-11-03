import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseSession, type ParsedSession } from '@evaos/chat-core/session'
import { listSessionFiles } from '@evaos/chat-core/sessions-dir'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { blobAgentDirs, MediaError, readBlobImage } from './media'
import type { RemoteSessions } from './remote-sessions'

class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The real path of `file` and of each existing sessions directory; refuses anything outside them. */
function resolveInside(
  sessionsDirs: readonly string[],
  file: string,
): { real: string; bases: string[] } {
  const bases: string[] = []
  for (const dir of sessionsDirs) {
    try {
      bases.push(fs.realpathSync(dir))
    } catch {
      // a missing store holds no chats
    }
  }
  if (bases.length === 0) {
    throw new CodedError('outside-sessions-dir', 'Sessions directory not found')
  }
  let real: string
  try {
    real = fs.realpathSync(file)
  } catch {
    throw new CodedError('outside-sessions-dir', 'Session file not found in the sessions directory')
  }
  if (!bases.some((base) => real.startsWith(base + path.sep))) {
    throw new CodedError('outside-sessions-dir', 'Session file is outside the sessions directory')
  }
  return { real, bases }
}

/**
 * Resolves `file` and refuses anything that is not a top-level `.jsonl` session directly inside
 * one of the sessions directories the chat list spans (T-01-12).
 */
export function resolveInsideSessionsDir(sessionsDirs: readonly string[], file: string): string {
  const { real, bases } = resolveInside(sessionsDirs, file)
  // Only top-level `.jsonl` regular files are sessions; subagent transcripts, folders and other files are not.
  if (
    !bases.includes(path.dirname(real)) ||
    !real.endsWith('.jsonl') ||
    !fs.statSync(real).isFile()
  ) {
    throw new CodedError('outside-sessions-dir', 'Not a session file')
  }
  return real
}

/**
 * Resolves a subagent transcript: a `.jsonl` regular file inside a session's folder, below the
 * top level of one of the sessions directories. Read only; it never becomes a pane.
 */
export function resolveSubagentTranscript(sessionsDirs: readonly string[], file: string): string {
  const { real, bases } = resolveInside(sessionsDirs, file)
  if (
    bases.includes(path.dirname(real)) ||
    !real.endsWith('.jsonl') ||
    !fs.statSync(real).isFile()
  ) {
    throw new CodedError('outside-sessions-dir', 'Not a subagent transcript')
  }
  return real
}

export function registerTranscriptIpc(
  ctx: MainContext,
  sessionsDirs: readonly string[],
  onOpened?: (paneId: string, file: string, parsed: ParsedSession) => void,
  ownerOf?: (file: string) => string | null,
  /** The remote host's mirror: a chat is fetched in full on open, a missing image on read. */
  remote?: RemoteSessions | null,
): void {
  handle(ctx, 'chat.listSessions', () => ({ sessions: listSessionFiles(ctx.env.sessionsDir) }))
  handle(ctx, 'chat.open', async ({ paneId, file }) => {
    await remote?.open(file)
    const real = resolveInsideSessionsDir(sessionsDirs, file)
    const parsed = parseSession(fs.readFileSync(real, 'utf8'))
    onOpened?.(paneId, real, parsed)
    return { ...parsed, owner: ownerOf?.(real) ?? null }
  })
  const agentDirs = blobAgentDirs(ctx.env.agentDir, sessionsDirs)
  handle(ctx, 'chat.readImage', async ({ token }) => {
    try {
      return readBlobImage(agentDirs, token)
    } catch (e) {
      if (!remote || !(e instanceof MediaError) || e.code !== 'image-not-found') throw e
    }
    await remote.blob(token.slice('blob:sha256:'.length))
    return readBlobImage(agentDirs, token)
  })
  handle(ctx, 'chat.readSubagent', async ({ file }) => {
    // Remote host: the artifact names the host's path; fetch it (and tail it) into the mirror first.
    const mirrored = remote ? await remote.openSubagent(file) : null
    const real = resolveSubagentTranscript(sessionsDirs, mirrored ?? file)
    const { title, messages } = parseSession(fs.readFileSync(real, 'utf8'))
    return { title, messages }
  })
}
