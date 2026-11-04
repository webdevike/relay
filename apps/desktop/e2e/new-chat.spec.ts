import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, writeChatPrefs, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

// New chat: a draft pane, a direct omp (or Claude bridge) child with no --resume, and a tab that
// ends up pointing at the session file the child created.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-newchat-${process.pid}.log`)

type Ev = { event: string; detail: { message?: string; argv?: string[] } | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []
const prompts = (): string[] =>
  readLog()
    .filter((e) => e.event === 'prompt')
    .map((e) => e.detail?.message ?? '')

type Hooks = { stats(p: string): { spawnArgs: string[] } }

let fx: ChatFixture
let before: string[] = []
const jsonl = (): string[] => fs.readdirSync(fx.sessionsDir).filter((n) => n.endsWith('.jsonl'))

const test = base.extend<{ claude: boolean }>({
  claude: [false, { option: true }],
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    before = jsonl()
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5', FAKE_OMP_LOG: LOG })
    fx.cleanup()
  },
  configDir: async ({ configDir, claude }, use) => {
    if (claude) writeChatPrefs(configDir, { harness: 'claude' })
    await use(configDir)
  },
})

test.beforeEach(() => {
  fs.rmSync(LOG, { force: true })
})
test.afterAll(() => {
  fs.rmSync(LOG, { force: true })
})

const newChat = async (shell: Page): Promise<void> => {
  await shell.locator('[data-testid=nav-chat]').click()
  await shell.locator('[data-testid=chat-new]').click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText('New chat')
}
const send = async (shell: Page, text: string): Promise<void> => {
  const box = shell.locator('[data-testid=composer-input]')
  await box.fill(text)
  await box.press('Enter')
}
const activeChatPlace = (shell: Page): Promise<string | null> =>
  shell.evaluate(() => {
    const t = (
      window as unknown as {
        __evaosShell: {
          tabs(): { active: number; list: Array<{ id: number; chat: string | null }> }
        }
      }
    ).__evaosShell.tabs()
    return t.list[t.active]?.chat ?? null
  })

test.describe('new chat on omp', () => {
  test('streams a reply, binds the new session file and tags the prompt', async ({
    app,
    shell,
  }) => {
    await newChat(shell)
    await send(shell, 'hello new chat')
    const log = shell.locator('[data-testid=chat-log]')
    await expect(log).toContainText('hello new chat')
    await expect(log).toContainText('Foxes are primarily nocturnal hunters')

    // The chat's pane id (each app tab's chat mounts under a fresh one).
    const paneId = await shell
      .locator('[data-testid=chat-pane][data-chat-pane]:visible')
      .getAttribute('data-chat-pane')
    const main = await app.evaluate(
      (_e, p) =>
        (
          globalThis as unknown as { __evaosTest: { hooks: { chat: Hooks } } }
        ).__evaosTest.hooks.chat.stats(p),
      paneId!,
    )
    expect(main.spawnArgs).toContain('--mode')
    expect(main.spawnArgs).toContain('rpc-ui')
    expect(main.spawnArgs).not.toContain('--resume')

    await expect.poll(() => jsonl().filter((n) => !before.includes(n)).length).toBe(1)
    const created = path.join(
      fx.sessionsDir,
      jsonl().find((n) => !before.includes(n))!,
    )
    await expect.poll(() => activeChatPlace(shell)).toBe(created)

    const first = prompts()[0]!
    expect(first.startsWith('<surface>')).toBe(true)
    expect(first).toContain(' - Relay Desktop</surface>')
    expect(first).toContain('hello new chat')
    await proofShot(app, shell, 'new-chat', { phase: 'phase-4' })
  })

  test('a steer carries exactly one surface tag', async ({ shell }) => {
    await newChat(shell)
    await send(shell, 'first [slow]')
    await expect(shell.locator('[data-testid=chat-log]')).toContainText('first [slow]')
    await send(shell, 'steer now')
    await expect.poll(() => prompts().length).toBe(2)
    for (const p of prompts()) {
      expect(p.split('<surface>').length - 1).toBe(1)
      expect(p.split(' - Relay Desktop</surface>').length - 1).toBe(1)
    }
  })
})

test.describe('new chat on the Claude harness', () => {
  test.use({ claude: true })

  test('runs through the Claude bridge and streams the same way', async ({ app, shell }) => {
    await newChat(shell)
    await send(shell, 'hello claude')
    const log = shell.locator('[data-testid=chat-log]')
    await expect(log).toContainText('hello claude')
    await expect(log).toContainText('Foxes are primarily nocturnal hunters')
    await expect.poll(() => readLog().some((e) => e.event === 'claude-bridge')).toBe(true)
    const argv = readLog().find((e) => e.event === 'claude-bridge')!.detail!.argv!
    expect(argv).toContain('--rpc')
    expect(argv).not.toContain('--resume')
    expect(prompts()[0]).toContain('<surface>')
    await proofShot(app, shell, 'new-chat-claude', { phase: 'phase-4' })
  })
})
