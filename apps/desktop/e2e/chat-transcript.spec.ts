import * as path from 'node:path'
import { SESSIONS_FIXTURE_DIR } from './helpers/paths'
import { test, expect } from './fixtures'

type Eva = {
  invoke(c: string, i: unknown): Promise<{ ok: boolean; value?: { messages: unknown[] } }>
}

const SMALL = '2026-10-01T09-00-00-000Z_small'
const BENCH = '2026-10-02T09-00-00-000Z_bench5000'

test('chat transcript: past session shows the active branch with collapsed rows', async ({
  shell,
}) => {
  const list = shell.locator('[data-testid=session-list]')
  await expect(list).toContainText('Fixture chat')
  await expect(list).toContainText('Benchmark 5000')
  await shell.locator(`[data-testid=session-${SMALL}]`).click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText('Fixture chat')

  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toContainText('Please sketch a tiny greeter.')
  await expect(log).not.toContainText('<surface>')
  await expect(log).toContainText('Thanks, <b>bold</b> stays literal.')

  const thinking = log.locator('[data-testid=thinking-u1-thinking], [data-testid$="-thinking"]')
  await expect(thinking.first()).toContainText('Thinking')
  await expect(log).not.toContainText('Weighing a one line greeter')
  await thinking.first().locator('button').click()
  await expect(log).toContainText('Weighing a one line greeter')

  const tool = log.locator('[data-testid$="-tool0"]').first()
  await expect(tool).toContainText('read')
  await expect(tool).toContainText('done')

  await expect(log.locator('pre').first()).toContainText('function greet(name: string) {')
  await expect(log.locator('pre').first()).toContainText('return `Hello, ${name}`')

  await expect(log).not.toContainText('ABANDONED-BRANCH-REPLY')
  await expect(log).not.toContainText('AGENT-HANDOFF-HIDDEN')
})

test('chat transcript: 5,000 message session mounts a window and opens at the end', async ({
  shell,
}) => {
  await shell.locator(`[data-testid=session-${BENCH}]`).click()
  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toBeVisible()
  await expect(log).toContainText('LAST-MESSAGE-MARKER')
  const mounted = await shell.locator('[data-testid^=msg-]').count()
  expect(mounted).toBeGreaterThan(0)
  expect(mounted).toBeLessThan(200)

  const open = await shell.evaluate(
    (file) =>
      (window as unknown as { eva: Eva }).eva.invoke('chat.open', { paneId: 'pane-9', file }),
    path.join(SESSIONS_FIXTURE_DIR, `${BENCH}.jsonl`),
  )
  expect(open.ok).toBe(true)
  expect(open.value!.messages.length).toBeGreaterThanOrEqual(5000)

  const outside = await shell.evaluate(() =>
    (window as unknown as { eva: Eva }).eva.invoke('chat.open', {
      paneId: 'pane-9',
      file: '/etc/hosts',
    }),
  )
  expect(outside.ok).toBe(false)
})
