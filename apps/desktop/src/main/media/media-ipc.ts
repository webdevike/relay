import { app, clipboard, dialog } from 'electron'
import * as fs from 'node:fs'
import type { MediaDeps } from '../chat/widget-media'
import { clipboardImage, copyImageToClipboard } from '../canvas/clipboard-image'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { registerTestHook } from '../test-hooks'
import { copyMedia, saveMedia, type MediaActionDeps } from './media-actions'

/**
 * The e2e stand-in for the save dialog and the clipboard (EVAOS_E2E=1 only): a spec sets `answer`
 * (an absolute path, or null to cancel) before it saves, then reads what was asked and written.
 * In e2e no OS dialog ever opens and Isaac's clipboard is never written.
 */
export interface MediaSaveHook {
  answer: string | null
  dialogs: Array<{ defaultPath: string; title: string }>
  saves: Array<{ path: string; bytes: number }>
  clipboard: Array<
    { kind: 'image'; width: number; height: number } | { kind: 'text'; text: string }
  >
}

const CAP = 50

function capped<T>(list: T[], item: T): void {
  list.push(item)
  if (list.length > CAP) list.shift()
}

function e2eDeps(media: MediaDeps): MediaActionDeps {
  const hook: MediaSaveHook = { answer: null, dialogs: [], saves: [], clipboard: [] }
  registerTestHook('mediaSave', hook)
  return {
    media,
    downloadsDir: () => app.getPath('downloads'),
    chooseSavePath: async (opts) => {
      capped(hook.dialogs, opts)
      return hook.answer
    },
    writeImage: async (bytes) => {
      const { width, height } = clipboardImage(bytes).getSize()
      capped(hook.clipboard, { kind: 'image', width, height })
    },
    writeText: (text) => capped(hook.clipboard, { kind: 'text', text }),
    onSaved: (file) => capped(hook.saves, { path: file, bytes: fs.statSync(file).size }),
  }
}

function liveDeps(ctx: MainContext, media: MediaDeps): MediaActionDeps {
  return {
    media,
    downloadsDir: () => app.getPath('downloads'),
    chooseSavePath: async ({ defaultPath, title }) => {
      const opts = { defaultPath, title, properties: ['createDirectory' as const] }
      const r = ctx.win.isDestroyed()
        ? await dialog.showSaveDialog(opts)
        : await dialog.showSaveDialog(ctx.win, opts)
      return r.canceled || !r.filePath ? null : r.filePath
    },
    writeImage: copyImageToClipboard,
    writeText: (text) => clipboard.writeText(text),
  }
}

/** `media.save` and `media.copy`: a chat image's or video's right-click menu and the viewers. */
export function registerMediaIpc(ctx: MainContext, media: MediaDeps): void {
  const deps = ctx.env.e2e ? e2eDeps(media) : liveDeps(ctx, media)
  handle(ctx, 'media.save', ({ src, name }) => saveMedia(src, name, deps))
  handle(ctx, 'media.copy', ({ src, what }) => copyMedia(src, what, deps))
}
