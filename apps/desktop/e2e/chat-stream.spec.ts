import * as fs from 'node:fs'
import * as path from 'node:path'
import { EVA_FIXTURE_ROOT, FIXTURES_DIR, SESSIONS_FIXTURE_DIR } from './helpers/paths'
import { test, expect } from './fixtures'

const SMALL = '2026-10-01T09-00-00-000Z_small'
const PANE = 'pane-1'

// The final assistant text of the recorded turn is what the stream must converge to.
const recorded = fs
  .readFileSync(path.join(FIXTURES_DIR, 'fake-omp/recordings/turn.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(
    (l) =>
      JSON.parse(l).frame as {
        type: string
        message?: { role: string; content: { text: string }[] }
      },
  )
  .filter((f) => f.type === 'message_end' && f.message?.role === 'assistant')
  .pop()!.message!.content[0]!.text

type Stats = { batches: number; gaps: number; snapshots: number; lastSeq: number }
type Hooks = {
  dropNextBatch(p: string): void
  stats(p: string): {
    batches: number
    lastSeq: number
    spawnArgs: string[]
    pid: number | null
    cwd: string
  }
}

const rendererStats = (page: import('@playwright/test').Page) =>
  page.evaluate(
    (p) => (window as unknown as { __evaosChatStats: Record<string, Stats> }).__evaosChatStats[p]!,
    PANE,
  )

for (const chunk of ['line', '1', 'glued', 'emoji-split']) {
  test.describe(`chunk mode ${chunk}`, () => {
    test.use({ launchEnv: { FAKE_OMP_CHUNK: chunk, FAKE_OMP_DELAY_MS: '5' } })

    test('streams the reply in order with zero gaps', async ({ shell, app }) => {
      await shell.locator(`[data-testid=session-${SMALL}]`).click()
      const log = shell.locator('[data-testid=chat-log]')
      await expect(log).toContainText('Please sketch a tiny greeter.')
      await shell.locator('[data-testid=composer-input]').fill('Say hello')
      await shell.locator('[data-testid=composer-input]').press('Enter')
      await expect(log).toContainText('Say hello')
      if (chunk !== 'glued') {
        await expect(
          shell.locator('[data-testid=chat-header] [aria-label="Eva is replying"]'),
        ).toBeVisible()
      }
      await expect(log).toContainText('Foxes are primarily nocturnal hunters')
      await expect(log).toContainText('🚀')
      await expect(
        shell.locator('[data-testid=chat-header] [aria-label="Eva is replying"]'),
      ).toHaveCount(0)

      // The final text appears exactly once, code fence included.
      const body = (await log.innerText()).replace(/\s+/g, ' ')
      expect(body.split('Foxes are primarily nocturnal hunters').length - 1).toBe(1)
      await expect(log.locator('pre').last()).toContainText('const foxHabits')
      expect(recorded).toContain('const foxHabits')
      // The optimistic prompt was replaced by omp's echo, not duplicated.
      expect(body.split('Say hello').length - 1).toBe(1)

      const s = await rendererStats(shell)
      expect(s.gaps).toBe(0)
      expect(s.lastSeq).toBe(s.batches)

      const main = await app.evaluate(() =>
        (
          globalThis as unknown as { __evaosTest: { hooks: { chat: Hooks } } }
        ).__evaosTest.hooks.chat.stats('pane-1'),
      )
      expect(main.spawnArgs).toEqual([
        '--mode',
        'rpc-ui',
        '--resume',
        fs.realpathSync(path.join(SESSIONS_FIXTURE_DIR, `${SMALL}.jsonl`)),
      ])
      expect(fs.realpathSync(main.cwd)).toBe(fs.realpathSync(EVA_FIXTURE_ROOT))
    })
  })
}

test.describe('gap recovery', () => {
  test.use({ launchEnv: { FAKE_OMP_CHUNK: 'line', FAKE_OMP_DELAY_MS: '40' } })

  test('a dropped batch shows Reconnecting then heals from a snapshot', async ({ shell, app }) => {
    await shell.locator(`[data-testid=session-${SMALL}]`).click()
    const log = shell.locator('[data-testid=chat-log]')
    await expect(log).toContainText('Please sketch a tiny greeter.')
    await app.evaluate(() => {
      ;(
        globalThis as unknown as { __evaosTest: { hooks: { chat: Hooks } } }
      ).__evaosTest.hooks.chat.dropNextBatch('pane-1')
    })
    await shell.locator('[data-testid=composer-input]').fill('Say hello')
    await shell.locator('[data-testid=composer-input]').press('Enter')
    await expect(shell.locator('[data-testid=chat-header]')).toContainText(
      'Reconnecting to the stream.',
    )
    await expect(shell.locator('[data-testid=chat-header]')).not.toContainText(
      'Reconnecting to the stream.',
    )
    await expect(log).toContainText('Foxes are primarily nocturnal hunters')
    await expect(log).toContainText('🚀')
    const body = (await log.innerText()).replace(/\s+/g, ' ')
    expect(body.split('Foxes are primarily nocturnal hunters').length - 1).toBe(1)
    const s = await rendererStats(shell)
    expect(s.snapshots).toBeGreaterThanOrEqual(1)
  })
})
