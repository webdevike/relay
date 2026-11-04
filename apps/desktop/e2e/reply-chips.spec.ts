// Tap-to-answer reply chips: opens a session (fixtures/agent-replies) whose newest reply ends on
// `[[replies: Yes, push it | Not yet | Show me the diff]]` and an older one that also carried a
// token. Checks the token never shows, only the newest reply gets chips, and a tap sends the label
// as Isaac's next turn through the composer path (fake omp receives it) without touching the
// draft, after which the chips are gone. Saves light and dark screenshots to proof/reply-chips/.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/reply-chips.spec.ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { writeChatPrefs } from './helpers/chat-fixture'
import { FIXTURES_DIR, REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'
import { pickScheme } from './helpers/appearance'

const OUT = path.join(REPO_ROOT, 'proof', 'reply-chips')
const TEMPLATE = path.join(FIXTURES_DIR, 'agent-replies')
const TITLE = 'Release check'
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'
const LABELS = ['Yes, push it', 'Not yet', 'Show me the diff']

type MainGlobal = {
  __evaosTest: { win: { setContentSize(w: number, h: number): void } }
}

interface Copy {
  root: string
  log: string
  env: Record<string, string>
}

function copyFixture(): Copy {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-reply-chips-'))
  const agentDir = path.join(root, 'agent')
  fs.cpSync(TEMPLATE, agentDir, { recursive: true })
  const sessionsDir = path.join(agentDir, 'sessions', '-fixture')
  const minutes = JSON.parse(fs.readFileSync(path.join(agentDir, 'mtimes.json'), 'utf8')) as Record<
    string,
    number
  >
  for (const name of fs.readdirSync(sessionsDir)) {
    const id = name.slice(name.indexOf('_') + 1, -'.jsonl'.length)
    const when = new Date(Date.now() - minutes[id]! * 60_000)
    fs.utimesSync(path.join(sessionsDir, name), when, when)
  }
  const log = path.join(root, 'fake-omp.log')
  return {
    root,
    log,
    env: {
      EVAOS_AGENT_DIR: agentDir,
      EVAOS_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_LOG: log,
      FAKE_OMP_DELAY_MS: '5',
    },
  }
}

let copy: Copy
const test = base.extend({
  launchEnv: async ({}, use) => {
    copy = copyFixture()
    await use(copy.env)
    fs.rmSync(copy.root, { recursive: true, force: true })
  },
  configDir: async ({ configDir }, use) => {
    writeChatPrefs(configDir, { show_thinking: true, show_tools: true })
    await use(configDir)
  },
})

test.use({ reducedMotion: 'reduce', toolPanes: false })

/** Prompts fake omp received (FAKE_OMP_LOG), without the `<surface>` line main puts first. */
function prompts(): string[] {
  if (!fs.existsSync(copy.log)) return []
  return fs
    .readFileSync(copy.log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; detail: { message?: string } })
    .filter((e) => e.event === 'prompt')
    .map((e) => (e.detail.message ?? '').replace(/^<surface>.*<\/surface>\n/, ''))
}

const frames = (shell: Page): Promise<void> =>
  shell.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )

async function scheme(shell: Page, s: 'light' | 'dark') {
  await pickScheme(shell, s)
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', s)
}

/** Scrolls the virtualized log to its end, repeated while rows measure. */
async function toEnd(shell: Page) {
  for (let i = 0; i < 4; i++) {
    await shell.locator(LOG).evaluate((el) => {
      const list = el.firstElementChild as HTMLElement
      list.scrollTop = list.scrollHeight
    })
    await frames(shell)
  }
}

async function shot(app: ElectronApplication, shell: Page, name: string) {
  await frames(shell)
  const tmp = await proofShot(app, shell, name, { phase: 'reply-chips' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
}

test('the newest reply offers its answers as chips; a tap sends one as the next turn', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(w, h),
    [1280, 800] as const,
  )
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText(TITLE)
  const log = shell.locator(LOG)
  await toEnd(shell)
  await expect(log).toContainText('Ready to push it and open the PR?')

  // The token never shows, on the newest reply or the older one; only the newest has chips.
  await expect(log).not.toContainText('[[replies')
  await expect(log).toContainText('Want me to start on the PDF export next?')
  const group = log.getByRole('group', { name: 'Suggested replies' })
  await expect(group).toHaveCount(1)
  await expect(group.getByRole('button')).toHaveText(LABELS)
  await expect(log.getByRole('button', { name: 'Yes, start PDF' })).toHaveCount(0)
  // Under the reply, left-aligned with it.
  const reply = log.getByText('Ready to push it and open the PR?')
  const [text, chips] = [(await reply.boundingBox())!, (await group.boundingBox())!]
  expect(chips.y).toBeGreaterThan(text.y + text.height)
  expect(Math.abs(chips.x - text.x)).toBeLessThanOrEqual(1)

  await scheme(shell, 'light')
  await toEnd(shell)
  await shot(app, shell, 'desktop-after')
  await scheme(shell, 'dark')
  await toEnd(shell)
  await shot(app, shell, 'desktop-after-dark')
  await scheme(shell, 'light')

  // A tap sends the label through the composer's send; the draft stays as typed.
  const input = shell.locator('[data-testid=chat-pane] [data-testid=composer-input]')
  await input.fill('half a thought')
  expect(prompts()).toEqual([])
  await group.getByRole('button', { name: 'Not yet' }).click()
  await expect.poll(prompts, { timeout: 20_000 }).toEqual(['Not yet'])
  await expect(input).toHaveValue('half a thought')
  // Isaac's turn follows the reply, so the chips are gone.
  await expect
    .poll(async () => {
      await toEnd(shell)
      return log.locator('.eva-bubble', { hasText: 'Not yet' }).count()
    })
    .toBeGreaterThan(0)
  await expect(log.getByRole('group', { name: 'Suggested replies' })).toHaveCount(0)
})
