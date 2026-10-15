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

/** Resolves `file` and refuses anything that does not live inside the sessions directory (T-01-12). */
export function resolveInsideSessionsDir(sessionsDir: string, file: string): string {
  const base = fs.realpathSync(sessionsDir)
  let real: string
  try {
    real = fs.realpathSync(file)
  } catch {
    throw new CodedError('outside-sessions-dir', 'Session file not found in the sessions directory')
  }
  if (!real.startsWith(base + path.sep)) {
    throw new CodedError('outside-sessions-dir', 'Session file is outside the sessions directory')
  }
  return real
}

export function registerTranscriptIpc(
  ctx: MainContext,
  onOpened?: (paneId: string, file: string, parsed: ParsedSession) => void,
  ownerOf?: (file: string) => string | null,
): void {
  handle(ctx, 'chat.listSessions', () => ({ sessions: listSessionFiles(ctx.env.sessionsDir) }))
  handle(ctx, 'chat.open', ({ paneId, file }) => {
    const real = resolveInsideSessionsDir(ctx.env.sessionsDir, file)
    const parsed = parseSession(fs.readFileSync(real, 'utf8'))
    onOpened?.(paneId, real, parsed)
    return { ...parsed, owner: ownerOf?.(real) ?? null }
  })
  handle(ctx, 'chat.readImage', ({ token }) => readBlobImage(ctx.env.agentDir, token))
}
