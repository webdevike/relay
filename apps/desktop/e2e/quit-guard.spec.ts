import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

test.use({ startOnChat: false, colorScheme: 'dark' })

type Opts = {
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}
type GG = {
  __stubCalls: Opts[]
  __stubResponse: number
  __evaosTest: { hooks: { quitGuard: { guardedClose(): Promise<boolean>; approved(): boolean } } }
}
type Sh = {
  __evaosShell: {
    markDirty(l: string): string
    dirtySaves(): number
  }
}

async function stub(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as GG
    g.__stubCalls = []
    g.__stubResponse = 2
    ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (
      ...args: unknown[]
    ) => {
      g.__stubCalls.push(args[args.length - 1] as Opts)
      return { response: g.__stubResponse, checkboxChecked: false }
    }
  })
}
const answer = (app: ElectronApplication, r: number): Promise<void> =>
  app.evaluate((_e, v) => {
    ;(globalThis as unknown as GG).__stubResponse = v
  }, r)
const calls = (app: ElectronApplication): Promise<Opts[]> =>
  app.evaluate(() => (globalThis as unknown as GG).__stubCalls)
const guarded = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(() => (globalThis as unknown as GG).__evaosTest.hooks.quitGuard.guardedClose())
const winDestroyed = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.isDestroyed() ?? true)
const dirty = (page: Page, label: string): Promise<string> =>
  page.evaluate((l) => (window as unknown as Sh).__evaosShell.markDirty(l), label)

// Teardown quits the app, which the guard would hold open: answer Discard first.
test.afterEach(async ({ app }) => {
  await answer(app, 1).catch(() => undefined)
})

const TAIL = 'Save them before EvaOS closes, or discard them. Cancel keeps EvaOS open.'

test('Cancel keeps the window and the dialog has the UI-SPEC copy', async ({ app, shell }) => {
  await stub(app)
  await dirty(shell, 'notes.md')
  await answer(app, 2)
  expect(await guarded(app)).toBe(false)
  expect(await winDestroyed(app)).toBe(false)
  const [o] = await calls(app)
  expect(o!.message).toBe('You have unsaved changes')
  expect(o!.buttons).toEqual(['Save', 'Discard', 'Cancel'])
  expect(o!.defaultId).toBe(0)
  expect(o!.cancelId).toBe(2)
  expect(o!.detail).toContain('notes.md')
  expect(o!.detail.endsWith(TAIL)).toBe(true)
})

test('six dirty labels list five and "and 1 more"', async ({ app, shell }) => {
  await stub(app)
  for (let i = 1; i <= 6; i++) await dirty(shell, `file-${i}.md`)
  await answer(app, 2)
  expect(await guarded(app)).toBe(false)
  const [o] = await calls(app)
  expect(o!.detail).toContain('file-5.md')
  expect(o!.detail).not.toContain('file-6.md')
  expect(o!.detail).toContain('and 1 more')
})

test('Save runs the registered save, then nothing is left to ask', async ({ app, shell }) => {
  await stub(app)
  await dirty(shell, 'notes.md')
  await answer(app, 0)
  expect(await shell.evaluate(() => (window as unknown as Sh).__evaosShell.dirtySaves())).toBe(0)
  expect(await guarded(app)).toBe(true)
  expect(await shell.evaluate(() => (window as unknown as Sh).__evaosShell.dirtySaves())).toBe(1)
  expect(await calls(app)).toHaveLength(1)
})

// `shell` waits for the renderer to mount: before that nobody answers the guard, which now
// fails closed (asks the user) instead of treating silence as "nothing dirty".
test('nothing dirty closes without a dialog', async ({ app, shell: _shell }) => {
  await stub(app)
  expect(await guarded(app)).toBe(true)
  expect(await calls(app)).toHaveLength(0)
})

test('window close: Cancel stays open, Discard quits', async ({ app, shell }) => {
  await stub(app)
  await dirty(shell, 'notes.md')
  await answer(app, 2)
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.close())
  await expect.poll(async () => (await calls(app)).length).toBe(1)
  await new Promise((r) => setTimeout(r, 300))
  expect(await winDestroyed(app)).toBe(false)

  await answer(app, 1)
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.close())
  await closed
})
