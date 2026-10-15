import { app, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import type { MainContext } from './context'
import { emit, handle } from './ipc/handle'
import { registerTestHook } from './test-hooks'

export interface Entry {
  id: string
  label: string
}
export interface Failure extends Entry {
  message: string
}

export interface QuitGuardDeps {
  askEdits(): Promise<Entry[]>
  saveAll(): Promise<Failure[]>
  dialog: {
    confirm(message: string, detail: string): Promise<0 | 1 | 2>
    failure(message: string): Promise<void>
  }
}

const MAX_LABELS = 5

export function confirmDetail(entries: Entry[]): string {
  const shown = entries.slice(0, MAX_LABELS).map((e) => e.label)
  if (entries.length > MAX_LABELS) shown.push(`and ${entries.length - MAX_LABELS} more`)
  return `${shown.join('\n')}\n\nSave them before EvaOS closes, or discard them. Cancel keeps EvaOS open.`
}

export function createQuitGuard(deps: QuitGuardDeps): {
  guardedClose(): Promise<boolean>
  approved(): boolean
  pending(): boolean
} {
  let approved = false
  let inflight: Promise<boolean> | null = null

  async function run(): Promise<boolean> {
    const entries = await deps.askEdits()
    if (entries.length === 0) return true
    const choice = await deps.dialog.confirm('You have unsaved changes', confirmDetail(entries))
    if (choice === 2) return false
    if (choice === 1) return true
    const failures = await deps.saveAll()
    if (failures.length === 0) return true
    const f = failures[0]!
    await deps.dialog.failure(`Could not save ${f.label}. EvaOS stays open so nothing is lost.`)
    return false
  }

  return {
    approved: () => approved,
    pending: () => inflight !== null,
    guardedClose(): Promise<boolean> {
      if (approved) return Promise.resolve(true)
      if (inflight) return inflight
      inflight = run()
        .then((ok) => {
          if (ok) approved = true
          return ok
        })
        .catch(() => false)
        .finally(() => {
          inflight = null
        })
      return inflight
    },
  }
}

/** Pending request/reply pairs keyed by random id; unknown ids are ignored. */
export function createReplyRegistry(setTimeoutFn: typeof setTimeout = setTimeout): {
  request<T>(send: (id: string) => void, timeoutMs: number, onTimeout: T): Promise<T>
  resolve(id: string, value: unknown): void
} {
  const pending = new Map<string, (v: unknown) => void>()
  return {
    request<T>(send: (id: string) => void, timeoutMs: number, onTimeout: T): Promise<T> {
      const id = randomUUID()
      return new Promise<T>((resolve) => {
        const timer = setTimeoutFn(() => {
          pending.delete(id)
          resolve(onTimeout)
        }, timeoutMs)
        pending.set(id, (v) => {
          clearTimeout(timer)
          resolve(v as T)
        })
        send(id)
      })
    },
    resolve(id, value) {
      const fn = pending.get(id)
      if (!fn) return
      pending.delete(id)
      fn(value)
    },
  }
}

export function installQuitGuard(ctx: MainContext): ReturnType<typeof createQuitGuard> {
  const edits = createReplyRegistry()
  const saves = createReplyRegistry()

  handle(ctx, 'app.unsavedEdits.reply', ({ id, entries }) => {
    edits.resolve(id, entries)
    return {}
  })
  handle(ctx, 'app.saveDirty.reply', ({ id, failures }) => {
    saves.resolve(id, failures)
    return {}
  })

  const box = (opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    ctx.win.isDestroyed()
      ? dialog.showMessageBox(opts)
      : dialog
          .showMessageBox(ctx.win as unknown as Electron.BrowserWindow, opts)
          .catch(() => dialog.showMessageBox(opts))

  const guard = createQuitGuard({
    askEdits: () =>
      edits.request<Entry[]>((id) => emit(ctx, 'app.unsavedEdits.request', { id }), 2000, []),
    saveAll: () =>
      saves.request<Failure[]>((id) => emit(ctx, 'app.saveDirty.request', { id }), 30_000, [
        { id: 'timeout', label: 'your changes', message: 'Save timed out' },
      ]),
    dialog: {
      async confirm(message, detail) {
        const r = await box({
          type: 'question',
          message,
          detail,
          buttons: ['Save', 'Discard', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        })
        return (r.response === 0 || r.response === 1 ? r.response : 2) as 0 | 1 | 2
      },
      async failure(message) {
        await box({ type: 'error', message, buttons: ['OK'], noLink: true })
      },
    },
  })

  ctx.win.on('close', (e) => {
    if (guard.approved()) return
    e.preventDefault()
    void guard.guardedClose().then((ok) => {
      if (ok && !ctx.win.isDestroyed()) ctx.win.close()
    })
  })

  // Registered before the quit-hooks listener in index.ts, so it runs first.
  app.on('before-quit', (event) => {
    if (guard.approved()) return
    event.preventDefault()
    void guard.guardedClose().then((ok) => {
      if (ok) app.quit()
    })
  })

  registerTestHook('quitGuard', {
    approved: () => guard.approved(),
    guardedClose: () => guard.guardedClose(),
  })
  return guard
}
