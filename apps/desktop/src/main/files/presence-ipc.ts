import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayFrames } from '../relay/client'
import { createFilesPresence, localHostPath, type FilesPresence } from './presence'

/**
 * Agent cursors and Isaac's caret in the Files editor, through the Relay Host (presence.ts).
 * `hostFile` names the Mini's file behind a host-backed root (an assistant's instruction files on
 * a thin client); any other root is the host's own disk on the Mini and nothing on a thin client.
 */
export function registerFilesPresenceIpc(
  ctx: MainContext,
  frames: RelayFrames,
  origin: () => string | null,
  hostFile: (root: string, rel: string) => string | null,
): FilesPresence {
  const local = localHostPath(ctx.env.relayRemote !== null)
  const presence = createFilesPresence({
    frames,
    hostPathOf: (root, rel) => hostFile(root, rel) ?? local(root, rel),
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
