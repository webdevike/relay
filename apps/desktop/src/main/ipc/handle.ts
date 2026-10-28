import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  err,
  eventContract,
  invokeContract,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeParsed,
  type InvokeOutput,
  type Result,
} from '@evaos/contract'
import type { MainContext } from '../context'
import { isAppUrl } from '../window'

export function handle<K extends InvokeChannel>(
  _ctx: MainContext,
  channel: K,
  fn: (
    input: InvokeParsed<K>,
    event: IpcMainInvokeEvent,
  ) => Promise<InvokeOutput<K>> | InvokeOutput<K>,
): void {
  const entry = invokeContract[channel]
  ipcMain.handle(channel, async (event, raw): Promise<Result<InvokeOutput<K>>> => {
    if (!isAppUrl(event.senderFrame?.url)) {
      return err('forbidden', 'Caller is not the app shell') as Result<InvokeOutput<K>>
    }
    const parsed = entry.input.safeParse(raw)
    if (!parsed.success) {
      return err('invalid-input', parsed.error.message) as Result<InvokeOutput<K>>
    }
    try {
      const value = await fn(parsed.data as InvokeParsed<K>, event)
      const out = app.isPackaged ? value : (entry.output.parse(value) as InvokeOutput<K>)
      return { ok: true, value: out }
    } catch (e) {
      // A handler can fail with a stable kebab-case code (for example `outside-sessions-dir`).
      const code = (e as { code?: unknown } | null)?.code
      if (typeof code === 'string' && /^[a-z][a-z-]*$/.test(code)) {
        return err(code, e instanceof Error ? e.message : String(e)) as Result<InvokeOutput<K>>
      }
      return err('internal', e instanceof Error ? e.message : String(e)) as Result<InvokeOutput<K>>
    }
  })
}

export function emit<K extends EventChannel>(
  ctx: MainContext,
  channel: K,
  payload: EventPayload<K>,
): void {
  void eventContract[channel]
  if (!ctx.shell.webContents.isDestroyed()) ctx.shell.webContents.send(channel, payload)
}
