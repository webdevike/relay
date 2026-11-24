import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    // The subagent b has said something by the time the chat is opened.
    const b = path.join(
      path.dirname(fx.file('p4-subagents')),
      path.basename(fx.file('p4-subagents'), '.jsonl'),
      'b.jsonl',
    )
    fs.appendFileSync(
      b,
      JSON.stringify({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Reading the   fixtures now.' }],
          stopReason: 'stop',
        },
      }) + '\n',
    )
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5' })
    fx.cleanup()
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`

async function openChat(shell: Page, id: string): Promise<void> {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[data-testid=chat-tree]')
  for (const more of await shell.locator('[data-testid^="chat-show-more-"]').all())
    await more.click()
  await shell.locator(sel(`chat-row-${id}`)).click()
  await expect(shell.locator(sel('chat-log')))
    .toContainText(`Hello from ${id}`, {
      timeout: 10_000,
    })
    .catch(async () => {
      await expect(shell.locator(sel('chat-header'))).toBeVisible()
    })
}

const subFolder = (): string =>
  path.join(path.dirname(fx.file('p4-subagents')), path.basename(fx.file('p4-subagents'), '.jsonl'))

const stack = (shell: Page) => shell.locator(sel('card-stack'))
const strip = (shell: Page) => shell.locator(sel('jobs-strip'))

test('a running subagent is a running card: Open session opens its transcript, and it leaves once done', async ({
  app,
  shell,
}) => {
  await openChat(shell, 'p4-subagents')
  // Only b runs; a finished, so it has no card (and one card shows no sliver behind it).
  await expect(stack(shell)).toHaveAttribute('data-front', 'sub:b')
  await expect(shell.locator(sel('card-stack-tab'))).toHaveText('b')
  await expect(shell.locator(sel('card-stack-peek'))).toHaveCount(0)

  // The log stays pinned to the bottom when the stack appears.
  const gap = await shell.evaluate(() => {
    const el = document.querySelector('[data-testid=chat-log]') as HTMLElement
    const scroller = (el.querySelector('[style*="overflow"]') as HTMLElement | null) ?? el
    return Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
  })
  expect(gap).toBeLessThanOrEqual(2)

  // Cmd+click on the tab's Open session opens its transcript in a tool pane tab, read only.
  await shell.locator(sel('card-stack-open-link')).click({ modifiers: ['Meta'] })
  const tab = shell.locator('[data-testid^="pane-tab-subagent:"]')
  await expect(tab).toHaveCount(1)
  await expect(tab).toContainText('b')
  await expect(tab).toHaveAttribute('data-active', 'true')
  await expect(shell.locator(sel('subagent-transcript'))).toContainText('Reading the fixtures now.')
  await shell.locator('[data-testid^="pane-tab-close-subagent:"]').click()
  await expect(tab).toHaveCount(0)

  // Open, its recent work is its last line; without its helper run there is no clock or model.
  await shell.locator(sel('card-stack-tab')).click()
  await expect(stack(shell)).toHaveAttribute('data-state', 'expanded')
  await expect(shell.locator(sel('card-stack-title'))).toHaveText('b')
  await expect(shell.locator(sel('card-stack-log'))).toContainText(/Reading the\s+fixtures now\./)
  await expect(shell.locator(sel('card-stack-timer'))).toHaveCount(0)
  await expect(shell.locator(sel('card-stack-open-session'))).toBeVisible()
  await proofShot(app, shell, 'subagent-running-card', { phase: 'phase-4' })

  // omp writes b.md: b is finished within 500 ms of the file change, and its card leaves.
  fs.writeFileSync(path.join(subFolder(), 'b.md'), 'Subagent b finished.\n')
  await expect(stack(shell)).toHaveCount(0, { timeout: 1500 })
})

test('jobs strip: only while omp runs and a job is unfinished', async ({ app, shell }) => {
  await openChat(shell, 'p4-jobs')
  await expect(strip(shell)).toHaveCount(0)

  const box = shell.locator(sel('composer-input'))
  await box.fill('[slow] go')
  await box.press('Enter')
  await expect(strip(shell)).toContainText('1 background job running')
  await strip(shell).getByRole('button').first().click()
  const rows = shell.locator(sel('jobs-row'))
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('pnpm build --watch')
  await expect(rows.first().locator('[data-testid=jobs-elapsed]')).toHaveText(/^\d+[smh]/)
  await proofShot(app, shell, 'jobs-strip', { phase: 'phase-4' })

  // A delivery ends bg_1: the strip goes away.
  await fx.append(
    'p4-jobs',
    JSON.stringify({
      type: 'custom_message',
      id: 'd2',
      parentId: 'd1',
      details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] },
    }),
  )
  await expect(strip(shell)).toHaveCount(0, { timeout: 1500 })
})

test('jobs strip disappears when the process ends', async ({ shell }) => {
  await openChat(shell, 'p4-jobs')
  const box = shell.locator(sel('composer-input'))
  await box.fill('[slow] again')
  await box.press('Enter')
  await expect(strip(shell)).toContainText('1 background job running')
  const r = await shell.evaluate(() =>
    (
      window as unknown as { eva: { invoke(c: string, i: unknown): Promise<{ ok: boolean }> } }
    ).eva.invoke('chat.close', { paneId: 'pane-1' }),
  )
  expect(r.ok).toBe(true)
  await expect(strip(shell)).toHaveCount(0, { timeout: 5000 })
})
