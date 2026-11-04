import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayFrames } from '../relay/client'
import { createFilesPresence, localHostPath, type FilesPresence } from './presence'

/** Agent cursors and Isaac's caret in the Files editor, through the Relay Host (presence.ts). */
export function registerFilesPresenceIpc(
  ctx: MainContext,
  frames: RelayFrames,
  origin: () => string | null,
): FilesPresence {
  const presence = createFilesPresence({
    frames,
    hostPathOf: localHostPath(ctx.env.relayRemote !== null),
    origin,
    emitEdit: (edit) => emit(ctx, 'files.presence.edit', edit),
    emitFocus: (focus) => emit(ctx, 'files.presence.focus', { focus }),
  })
  handle(ctx, 'files.presence.open', ({ files }) => {
    presence.open(files)
    return {}
  })
  handle(ctx, 'files.presence.caret', ({ focus }) => {
    presence.caret(focus)
    return {}
  })
  ctx.onBeforeQuit(async () => presence.stop())
  return presence
}
