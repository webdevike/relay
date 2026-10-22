import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseSession, type ParsedSession } from '@evaos/chat-core/session'
import { listSessionFiles } from '@evaos/chat-core/sessions-dir'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { readBlobImage } from './media'

class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Resolves `file` and refuses anything that is not a top-level `.jsonl` session directly inside
 * one of the sessions directories the chat list spans (T-01-12).
 */
export function resolveInsideSessionsDir(sessionsDirs: readonly string[], file: string): string {
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

export function registerTranscriptIpc(
  ctx: MainContext,
  sessionsDirs: readonly string[],
  onOpened?: (paneId: string, file: string, parsed: ParsedSession) => void,
  ownerOf?: (file: string) => string | null,
): void {
  handle(ctx, 'chat.listSessions', () => ({ sessions: listSessionFiles(ctx.env.sessionsDir) }))
  handle(ctx, 'chat.open', ({ paneId, file }) => {
    const real = resolveInsideSessionsDir(sessionsDirs, file)
    const parsed = parseSession(fs.readFileSync(real, 'utf8'))
    onOpened?.(paneId, real, parsed)
    return { ...parsed, owner: ownerOf?.(real) ?? null }
  })
  handle(ctx, 'chat.readImage', ({ token }) => readBlobImage(ctx.env.agentDir, token))
}
