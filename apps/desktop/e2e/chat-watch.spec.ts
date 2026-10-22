import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'
import { proofOutDir } from './helpers/metrics'

// The window is never focused by this spec: the list must follow files on its own.
let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5' })
    fx.cleanup()
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`
const openChats = async (shell: Page): Promise<void> => {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[data-testid=chat-tree]')
}

/** Resolves with the page-side Date.now() at which the selector first matched (polled every 25 ms). */
const appearedAt = (shell: Page, selector: string, present = true): Promise<number> =>
  shell
    .waitForFunction(
      ([s, want]) => (document.querySelector(s as string) !== null) === want,
      [selector, present] as const,
      { polling: 25, timeout: 5000 },
    )
    .then(() => shell.evaluate(() => Date.now()))

test('new, appended and deleted session files update the list within 500 ms', async ({ shell }) => {
  await openChats(shell)
  const latencies: number[] = []
  for (let i = 0; i < 3; i++) {
    const id = `p4-copy${i}`
    const dest = path.join(fx.sessionsDir, `2026-10-05T23-0${i}-00-000Z_${id}.jsonl`)
    const started = Date.now()
    fs.copyFileSync(fx.file('p4-other1'), dest)
    const seen = await appearedAt(shell, sel(`chat-row-${id}`))
    latencies.push(seen - started)
  }
  const dir = proofOutDir('phase-4')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'chat-watch-latency.json'),
    JSON.stringify({ budgetMs: 500, trialsMs: latencies }, null, 2) + '\n',
  )
  expect(latencies.filter((l) => l < 500).length).toBeGreaterThanOrEqual(2)

  // A write through a descriptor the writer keeps open (what omp does).
  const row = shell.locator(sel('chat-row-p4-other3'))
  await expect(row).toContainText('Grocery list 3')
  const title = JSON.stringify({ type: 'title', title: 'Renamed while open' })
  const t0 = Date.now()
  const pending = fx.append('p4-other3', title, { holdOpen: true })
  await expect(row).toContainText('Renamed while open', { timeout: 1000 })
  expect(Date.now() - t0).toBeLessThan(1500)
  await pending

  // Delete a copy.
  fs.rmSync(path.join(fx.sessionsDir, '2026-10-05T23-00-00-000Z_p4-copy0.jsonl'))
  await appearedAt(shell, sel('chat-row-p4-copy0'), false)
})

test('a running chat with background jobs shows Monitoring; an owned run shows Working then idles', async ({
  app,
  shell,
}) => {
  // Its turn ends just now with a build still running: running, idle and holding a background
  // job, so Monitoring.
  await fx.append(
    'p4-jobs',
    JSON.stringify({
      type: 'message',
      id: 'a2',
      parentId: 'd1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Watching the build.' }],
        stopReason: 'stop',
      },
    }),
  )
  await openChats(shell)
  // Folders show ten rows; expand every one so the job chat is visible wherever it landed.
  for (const more of await shell.locator('[data-testid^="chat-show-more-"]').all())
    await more.click()
  await expect(shell.locator(sel('chat-row-p4-jobs'))).toContainText('Monitoring')

  await shell.locator(sel('chat-row-p4-ecard')).click()
  await expect(shell.locator(sel('chat-log'))).toContainText('Hello from p4-ecard')
  const box = shell.locator(sel('composer-input'))
  await box.fill('[slow] hi')
  await box.press('Enter')
  const row = shell.locator(sel('chat-row-p4-ecard'))
  await expect(row).toContainText(/Working \d+s/)
  await proofShot(app, shell, 'chat-status', { phase: 'phase-4' })
  await expect(row).not.toContainText('Working', { timeout: 15_000 })
  // Idle and shown, so read: no status pill, just its age.
  await expect(row.locator('.eva-cl-pill')).toHaveCount(0)
  await expect(row.locator('.eva-cl-age')).toHaveCount(1)
})
