import type { WebContentsView } from 'electron'
import type { MainContext } from './context'

interface TestGlobal {
  win: unknown
  shell: WebContentsView
  errors: string[]
  extraViews: WebContentsView[]
  views(): WebContentsView[]
  hooks: Record<string, unknown>
}

const g = globalThis as unknown as { __evaosTest?: TestGlobal }
const providers: Array<() => WebContentsView[]> = []

const pendingHooks: Record<string, unknown> = {}

/** Hooks registered before installTestHooks runs (e.g. the write guard) are kept and attached later. */
export function registerTestHook(name: string, value: unknown): void {
  if (g.__evaosTest) g.__evaosTest.hooks[name] = value
  else pendingHooks[name] = value
}

export function registerViewProvider(fn: () => WebContentsView[]): void {
  providers.push(fn)
}

/** Active only when EVAOS_E2E=1; otherwise nothing is exposed. */
export function installTestHooks(ctx: MainContext): void {
  if (!ctx.env.e2e) return
  const errors: string[] = []
  const t: TestGlobal = {
    win: ctx.win,
    shell: ctx.shell,
    errors,
    extraViews: [],
    hooks: { ...pendingHooks },
    views: () => [...t.extraViews, ...providers.flatMap((p) => p())],
  }
  g.__evaosTest = t
  ctx.shell.webContents.on('console-message', (details) => {
    // The ResizeObserver loop notice is a benign browser warning the virtualized log can trigger.
    if (details.level === 'error' && !details.message.startsWith('ResizeObserver loop'))
      errors.push(details.message)
  })
}
