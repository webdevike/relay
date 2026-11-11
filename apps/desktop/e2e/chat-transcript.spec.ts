import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SESSIONS_FIXTURE_DIR } from './helpers/paths'
import { test as base, expect } from './fixtures'

// Rust default is thinking off; this spec asserts the collapsed thinking row, so it opts in.
const test = base.extend<object>({
  configDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-e2e-'))
    fs.writeFileSync(path.join(dir, 'chat.json'), '{"show_thinking":true,"show_tools":true}')
    await use(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  },
})

type Eva = {
  invoke(c: string, i: unknown): Promise<{ ok: boolean; value?: { messages: unknown[] } }>
}

const BENCH = '2026-10-02T09-00-00-000Z_bench5000'

test('chat transcript: past session shows the active branch with thinking and tool rows', async ({
  shell,
}) => {
  await expect(shell.getByRole('heading', { name: 'What should Eva work on?' })).toBeVisible()
  await expect(shell.getByTestId('composer-input')).toHaveAttribute(
    'placeholder',
    'Ask anything, / for commands, @ for agents, Computer and skills',
  )
  await shell.getByTestId('nav-chat').click()
  const list = shell.getByTestId('chat-tree')
  await expect(list).toContainText('Fixture chat')
  await expect(list).toContainText('Benchmark 5000')
  await list.getByRole('link', { name: /^Fixture chat(?:,|$)/ }).click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText('Fixture chat')

  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toContainText('Please sketch a tiny greeter.')
  await expect(log).not.toContainText('<surface>')
  await expect(log).toContainText('Thanks, <b>bold</b> stays literal.')

  await expect(log.locator('.eva-thinking').first()).toContainText('Weighing a one line greeter')

  const tool = log.locator('[data-testid$="-tool0"]').first()
  await expect(tool).toContainText('read')

  const code = log.locator('[data-testid=code-block] pre').first()
  await expect(code).toContainText('function greet(name: string) {')
  await expect(code).toContainText('return `Hello, ${name}`')

  await expect(log).not.toContainText('ABANDONED-BRANCH-REPLY')
  await expect(log).not.toContainText('AGENT-HANDOFF-HIDDEN')
})

test('chat transcript: 5,000 message session mounts a window and opens at the end', async ({
  shell,
}) => {
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', {
      name: /^Benchmark 5000(?:,|$)/,
    })
    .click()
  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toBeVisible()
  await expect(log).toContainText('LAST-MESSAGE-MARKER')
  await expect
    .poll(() =>
      log.evaluate((el) => {
        const sc = el.firstElementChild as HTMLElement
        return sc.scrollHeight - sc.scrollTop - sc.clientHeight
      }),
    )
    .toBeLessThan(48)
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
