import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { test, expect } from './fixtures'

// Opt-in live spec: an agent's deep link (page.open reviews + item) opens PR
// eCardSystems/react-client-reports-app#246 in Reviews; @Astra in its comment box starts a real
// Astra session (real omp, her prime and thread memory from ~/Eva, her profile and model) as a
// private thread: his comment the root, her typing dots at once, then her streamed answer as a
// reply under it. A plain reply typed in the thread's own box (no @Astra) goes to the same session
// and lands in the same thread. Use as reply fills the comment box (the GitHub post still asks
// first and is a dry run here), Open session shows the session in the chat view, and tab.open
// shows the PR in Reviews beside the chat. The test asks only read-only questions.
// EVAOS_REVIEWS_SHOTS=<dir> keeps the screenshots there (frames/ holds the typing-to-text frames).
test.skip(process.env.EVAOS_LIVE !== '1', 'a real Astra session is opt-in (EVAOS_LIVE=1)')

const EVA = path.join(os.homedir(), 'Eva')
test.use({
  launchEnv: {
    EVAOS_LIVE: '1',
    EVAOS_EVA_ROOT: EVA,
    EVAOS_OMP_BIN: process.env.EVAOS_OMP_BIN ?? path.join(os.homedir(), '.local/bin/omp'),
    EVAOS_REVIEWS_GH: '1',
    EVAOS_AGENT_CONTROL: '1',
  },
})
test.setTimeout(900_000)

const URL = 'https://github.com/eCardSystems/react-client-reports-app/pull/246'
const sel = (id: string): string => `[data-testid="${id}"]`
const SHOTS = process.env.EVAOS_REVIEWS_SHOTS ?? path.join(__dirname, '../test-results/reviews')

async function shot(shell: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/** Screenshots every ~250 ms until `done` holds: the typing dots giving way to her words. */
async function frames(shell: Page, prefix: string, done: () => Promise<boolean>): Promise<void> {
  const dir = path.join(SHOTS, 'frames')
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 400; i++) {
    await shell.screenshot({ path: path.join(dir, `${prefix}-${String(i).padStart(3, '0')}.png`) })
    if (await done()) return
    await shell.waitForTimeout(250)
  }
}

const Turns = z.object({
  file: z.string().nullable(),
  turns: z.array(z.object({ role: z.string(), text: z.string() })),
})
const session = async (shell: Page) =>
  Turns.parse(
    await shell.evaluate(async (url) => {
      const w = window as unknown as {
        eva: { invoke(c: string, i: unknown): Promise<{ value: unknown }> }
      }
      return (await w.eva.invoke('reviews.astraThread', { url })).value
    }, URL),
  )

const Control = z.object({ url: z.string(), token: z.string() })
/** Runs one agent action the way relay-ctl does: POST /actions/<id> with the control file's token. */
async function agent(configDir: string, id: string, params: Record<string, unknown>) {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { url, token } = Control.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  const res = await fetch(`${url}/actions/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  })
  return (await res.json()) as { ok: boolean }
}

test('@Astra starts a private thread; a plain reply in it goes to the same session', async ({
  app,
  shell,
  configDir,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))

  // An agent's deep link opens the PR in Reviews.
  expect(await agent(configDir, 'page.open', { page: 'reviews', item: URL })).toMatchObject({
    ok: true,
  })
  const conv = shell.locator(sel('review-conversation')).first()
  await expect(conv).toBeVisible({ timeout: 90_000 })
  await expect(shell.locator('.eva-rv-title')).toBeVisible()
  await shot(shell, 'thread-0-deeplink')

  // @Astra in the comment box: his comment roots a private thread, her typing dots show at once.
  const box = shell.locator(sel('review-composer'))
  await box.fill(
    '@Astra In two sentences: what does this PR change, and what is the riskiest part? Read only; do not post or send anything.',
  )
  await box.press('Meta+Enter')
  const thread = conv.locator(sel('review-astra-thread'))
  await expect(thread).toHaveCount(1)
  await expect(thread.locator(sel('review-astra-question'))).toContainText('riskiest part')
  await expect(thread.locator(sel('review-astra-typing'))).toBeVisible({ timeout: 5_000 })
  await expect(shell.getByText('Post this comment on GitHub?')).toHaveCount(0)
  await shot(shell, 'thread-1-typing')
  await frames(
    shell,
    'ask',
    async () => (await thread.locator(sel('review-astra-use')).count()) > 0,
  )
  await expect(thread.locator(sel('review-astra-use')).first()).toBeVisible({ timeout: 600_000 })
  await expect(thread.locator(sel('review-astra-typing'))).toHaveCount(0, { timeout: 120_000 })
  await expect(thread.locator(sel('review-astra')).first()).toContainText('AI assistant')
  await expect(thread.locator(sel('review-astra')).first()).toContainText('Private')
  await shot(shell, 'thread-2-answer')
  const first = (await session(shell)).file
  expect(first).toMatch(/\.jsonl$/)

  // A reply typed in the thread's own box: no @Astra, same session, same thread.
  const reply = thread.locator(sel('review-astra-thread-input'))
  await reply.fill('Which one file should I read first? One line.')
  await reply.press('Meta+Enter')
  await expect(thread.locator(sel('review-astra-thread-ask'))).toContainText('read first')
  await expect(thread.locator(sel('review-astra-typing'))).toBeVisible({ timeout: 5_000 })
  await shot(shell, 'thread-3-reply-typing')
  await frames(
    shell,
    'reply',
    async () => (await thread.locator(sel('review-astra-use')).count()) > 1,
  )
  await expect(thread.locator(sel('review-astra-use'))).toHaveCount(2, { timeout: 600_000 })
  await expect(conv.locator(sel('review-astra-thread'))).toHaveCount(1)
  const s = await session(shell)
  expect(s.file).toBe(first)
  expect(s.turns.filter((t) => t.role === 'user').at(-1)!.text).toMatch(
    /^\(Reply in your thread on "@Astra In two sentences/,
  )
  await shot(shell, 'thread-4-reply-answer')

  // Use as reply fills the comment box; posting it still asks first (and is a dry run in tests).
  await thread.locator(sel('review-astra-use')).last().click()
  await expect(box).not.toHaveValue('')
  await box.press('Meta+Enter')
  await expect(shell.getByText('Post this comment on GitHub?')).toBeVisible()
  await shell.getByRole('button', { name: 'Cancel' }).last().click()
  await box.fill('')

  // Beside the chat: tab.open shows Reviews on the PR in the pane right of the chat's.
  expect(
    await agent(configDir, 'tab.open', { kind: 'page', args: { page: 'reviews', item: URL } }),
  ).toMatchObject({ ok: true })
  await expect(
    shell.locator(`[data-pane-kind]:not([data-pane-id=p1]) ${sel('reviews-page')}`),
  ).toBeVisible()
  await shell.waitForTimeout(1500)
  await shot(shell, 'thread-5-side-pane')

  // Open session: the normal chat view on the same file.
  const main = shell.locator(`${sel('pane-body-p1')} ${sel('review-conversation')}`)
  await main.locator(sel('review-astra-open')).last().click()
  await expect(shell.locator(sel('page-chat-wrap'))).toBeVisible({ timeout: 20_000 })
  await shot(shell, 'thread-6-session')
})
