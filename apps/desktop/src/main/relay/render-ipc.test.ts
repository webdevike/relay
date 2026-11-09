import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
  BaseWindow: class {},
  WebContentsView: class {},
}))
vi.mock('../window', () => ({ isAppUrl: () => true }))

import type { MainContext } from '../context'
import type { RenderFailureReport } from './commands'
import { registerRenderIpc } from './render-ipc'

describe('render IPC', () => {
  const ctx = {
    shell: { webContents: { isDestroyed: () => false, send: () => {} } },
  } as unknown as MainContext
  const call = (input: unknown): Promise<unknown> =>
    ipc.handlers.get('render.failed')!({ senderFrame: { url: 'app://shell' } }, input)
  const failure = {
    thread: 'assistant:astra',
    message: 'assistant@5',
    kind: 'model',
    form: 'markdown',
    src: '/drops/d1/tok',
    error: 'served model/gltf-binary',
  }
  beforeEach(() => ipc.handlers.clear())

  it('passes a failure to the relay and says whether it went out', async () => {
    const got: RenderFailureReport[] = []
    let takes = true
    registerRenderIpc(ctx, {
      reportRender: (f) => {
        got.push(f)
        return takes
      },
    })
    expect(await call(failure)).toEqual({ ok: true, value: { sent: true } })
    takes = false
    expect(await call(failure)).toEqual({ ok: true, value: { sent: false } })
    expect(got).toEqual([failure, failure])
  })

  it('refuses a malformed report without touching the relay', async () => {
    const reportRender = vi.fn(() => true)
    registerRenderIpc(ctx, { reportRender })
    expect(await call({ ...failure, kind: 'pdf' })).toMatchObject({ ok: false })
    expect(reportRender).not.toHaveBeenCalled()
  })
})
