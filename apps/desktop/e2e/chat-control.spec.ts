import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SESSIONS_FIXTURE_DIR } from './helpers/paths'
import { test, expect } from './fixtures'

const SMALL = '2026-10-01T09-00-00-000Z_small'
const FILE = path.join(SESSIONS_FIXTURE_DIR, `${SMALL}.jsonl`)
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-${process.pid}.log`)

type Ev = { event: string; detail: { type?: string; argv?: string[] } | null }
type Eva = {
  invoke(
    c: string,
    i: unknown,
  ): Promise<{
    ok: boolean
    value?: { exit: { code: number | null; signal: string | null; timedOut: boolean } | null }
    error?: { code: string; message: string }
  }>
}
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []

test.describe('chat control', () => {
  test.use({
    launchEnv: { FAKE_OMP_RECORDING: 'long-turn', FAKE_OMP_DELAY_MS: '12', FAKE_OMP_LOG: LOG },
  })
  test.beforeEach(() => {
    fs.rmSync(LOG, { force: true })
  })
  test.afterAll(() => {
    fs.rmSync(LOG, { force: true })
  })

  const openAndSend = async (shell: import('@playwright/test').Page, text: string) => {
    await shell.getByTestId('nav-chat').click()
    await shell.getByTestId('chat-tree').getByRole('treeitem', {
      name: /^Fixture chat(?:,|$)/,
    }).click()
    await expect(shell.locator('[data-testid=chat-log]')).toContainText(
      'Please sketch a tiny greeter.',
    )
    const box = shell.locator('[data-testid=composer-input]')
    await box.fill(text)
    await box.press('Enter')
  }
  const dot = (shell: import('@playwright/test').Page) =>
    shell.locator('[data-testid=chat-header] [aria-label="Eva is replying"]')

  for (const how of ['button', 'escape']) {
    test(`abort by ${how} keeps the partial reply`, async ({ shell }) => {
      await openAndSend(shell, 'Tell me about foxes')
      const stop = shell.locator('[data-testid=composer-stop]')
      await expect(stop).toBeVisible()
      await expect(shell.locator('[data-testid=chat-log]')).toContainText('Foxes hunt at dusk')
      if (how === 'button') await stop.click()
      else await shell.locator('[data-testid=composer-input]').press('Escape')
      await expect(dot(shell)).toHaveCount(0)
      await expect(stop).toHaveCount(0)
      // The abort tail ends the assistant message as aborted and adds the Stopped. notice.
      await expect(shell.locator('[data-testid=chat-log]')).toContainText('Stopped.')
      await expect(shell.locator('[data-testid=chat-log]')).toContainText(
        'Octopuses have three hearts',
      )
      await expect.poll(() => readLog().some((e) => e.detail?.type === 'abort')).toBe(true)
    })
  }

  test('steer shows the optimistic row last and reconciles it once', async ({ shell }) => {
    await openAndSend(shell, 'First')
    await expect(shell.locator('[data-testid=composer-stop]')).toBeVisible()
    await expect(shell.locator('[data-testid=chat-log]')).toContainText('Foxes hunt at dusk')
    const box = shell.locator('[data-testid=composer-input]')
    await box.fill('Also this')
    await box.press('Enter')
    const rows = shell.locator('[data-testid^=msg-]')
    await expect(rows.last()).toContainText('Also this')
    await expect(rows.last()).toHaveAttribute('data-role', 'user')
    await expect
      .poll(() => readLog().filter((e) => e.detail?.type === 'prompt').length)
      .toBeGreaterThanOrEqual(2)
    await expect(shell.locator('[data-testid=chat-log]')).toContainText('Steer received:', {
      timeout: 30_000,
    })
    await expect(dot(shell)).toHaveCount(0, { timeout: 30_000 })
    await expect(
      shell.locator('[data-testid^=msg-][data-role=user]', { hasText: 'Also this' }),
    ).toHaveCount(1)
  })

  test('chat.close ends stdin and omp exits 0 with no signals', async ({ shell }) => {
    await openAndSend(shell, 'Hello')
    await expect(shell.locator('[data-testid=chat-log]')).toContainText('Foxes hunt at dusk')
    const r = await shell.evaluate(() =>
      (window as unknown as { eva: Eva }).eva.invoke('chat.close', { paneId: 'pane-1' }),
    )
    expect(r.ok).toBe(true)
    expect(r.value!.exit).toEqual({ code: 0, signal: null, timedOut: false })
    const events = readLog().map((e) => e.event)
    expect(events.indexOf('stdin-end')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('stdin-end')).toBeLessThan(events.indexOf('exit'))
    expect(events).not.toContain('signal')
    await expect(shell.locator('[data-testid=composer-input]')).toHaveAttribute(
      'placeholder',
      'Session is not running. Resume it to send a message.',
    )
    await expect(dot(shell)).toHaveCount(0)
    // The next send restarts it.
    const box = shell.locator('[data-testid=composer-input]')
    await box.fill('Again')
    await box.press('Enter')
    await expect
      .poll(
        () =>
          readLog().filter((e) => e.event === 'spawn' && e.detail?.argv?.includes('rpc-ui')).length,
      )
      .toBe(2)
  })

  test('quitting while a reply runs ends stdin only', async ({ shell, app }) => {
    await openAndSend(shell, 'Hello')
    await expect(shell.locator('[data-testid=chat-log]')).toContainText('Foxes hunt at dusk')
    await app.close().catch(() => undefined)
    await expect
      .poll(() => readLog().some((e) => e.event === 'exit'), { timeout: 15_000 })
      .toBe(true)
    const events = readLog().map((e) => e.event)
    expect(events.indexOf('stdin-end')).toBeLessThan(events.indexOf('exit'))
    expect(events).not.toContain('signal')
  })

  test('a second pane on the same file is refused', async ({ shell }) => {
    await openAndSend(shell, 'Hello')
    const r = await shell.evaluate(async (file) => {
      const eva = (window as unknown as { eva: Eva }).eva
      await eva.invoke('chat.open', { paneId: 'pane-2', file })
      return eva.invoke('chat.send', { paneId: 'pane-2', text: 'hi' })
    }, FILE)
    expect(r.ok).toBe(false)
    // Since 04-17 the refusal asks first; a confirmed send still never starts a second process.
    expect(r.error!.code).toBe('owned-elsewhere')
    expect(r.error!.message).toBe(
      'Another pane is writing to this chat. Sending from here may interleave messages.',
    )
  })
})
