// A reply that ends on `[[signin:<url>]]` (Eva's sign-in handoff) shows as the sign-in card in an
// assistant's thread, never as the raw token. `Use password` sends the credentials to the host as
// `assistant.signin` and shows the host's refusal or `Credentials submitted`; `Open Eva's browser`
// opens her live screen (EVA_COMPUTER_URL) as one page tab of the workspace, reused on a second
// click. Screenshots go to proof/chat-signin/. Offline by default (the page tab shows the blocked
// card); EVA_SCREEN=1 lets the tab load the real screen over the tailnet for a proof shot.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   [EVA_SCREEN=1] pnpm -C apps/desktop exec playwright test e2e/chat-signin.spec.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { EVA_COMPUTER_URL } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'
import { pageTabs, type BrowserHooks } from './helpers/web'

const OUT = path.join(REPO_ROOT, 'proof', 'chat-signin')
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'
const LEAD = 'Sign in needed: Sketchfab, to download the model.'
const URL = 'https://sketchfab.com/login'

const line = (entry: unknown): string => JSON.stringify(entry)

function sessionLines(id: string, cwd: string): string {
  const at = (m: number): string => new Date(Date.now() - (10 - m) * 60_000).toISOString()
  return (
    [
      line({ type: 'title', v: 1, title: 'Astra', source: 'auto', updatedAt: at(0) }),
      line({ type: 'session', version: 3, id, timestamp: at(0), cwd }),
      line({
        type: 'message',
        id: `${id}-u1`,
        parentId: null,
        timestamp: at(1),
        message: { role: 'user', content: [{ type: 'text', text: 'Grab that Sketchfab model.' }] },
      }),
      line({
        type: 'message',
        id: `${id}-a1`,
        parentId: `${id}-u1`,
        timestamp: at(2),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${LEAD} [[signin:${URL}]]` }],
          stopReason: 'stop',
        },
      }),
    ].join('\n') + '\n'
  )
}

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' }],
      }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-29T09-00-00-000Z_astra-1.jsonl'),
      sessionLines('astra-1', evaRoot),
    )
    await use({
      ...fx.launchEnv,
      EVAOS_EVA_ROOT: evaRoot,
      EVAOS_RELAY_DIR: relayDir,
      ...(process.env.EVA_SCREEN === '1' ? { EVAOS_E2E_NETWORK: '1' } : {}),
    })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false, reducedMotion: 'reduce' })

type MainGlobal = {
  __evaosTest: { win: { setContentSize(w: number, h: number): void } }
}

async function shot(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  await shell.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  const tmp = await proofShot(app, shell, name, { phase: 'chat-signin' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
}

const browserTabs = (app: ElectronApplication) =>
  app.evaluate(() =>
    (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host
      .snapshot()
      .tabs.map((t) => t.url),
  )

test("a sign-in reply is a card: password to the host, Eva's browser in a page tab", async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(w, h),
    [1280, 900] as const,
  )
  host.upsert({
    id: 'astra-1',
    status: 'idle',
    kind: 'assistant',
    assistant: 'astra',
    title: 'Astra',
  })
  await shell.getByTestId('nav-assistants').click()
  await shell.getByTestId('sidebar-agent-astra').click()
  const log = shell.locator(LOG)
  const card = log.getByTestId('signin-card')
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText('Sign in to sketchfab.com')
  await expect(log).toContainText(LEAD)
  await expect(log).not.toContainText('[[signin')
  await shot(app, shell, 'card')

  // A wrong password: the host's refusal shows and the form stays.
  host.nackNext = { code: 'invalid_command', message: 'Incorrect username or password.' }
  await card.getByTestId('signin-use-password').click()
  await card.getByLabel('Username or email').fill('isaac@example.com')
  await card.getByLabel('Password', { exact: true }).fill('wrong')
  await shot(app, shell, 'form')
  await card.getByRole('button', { name: 'Sign in' }).click()
  await expect(card.getByRole('alert')).toHaveText('Incorrect username or password.')
  await shot(app, shell, 'refused')

  // The right one: sent once to the agent's thread, then shown submitted.
  await card.getByLabel('Password', { exact: true }).fill('right')
  await card.getByRole('button', { name: 'Sign in' }).click()
  await expect(card).toContainText('Credentials submitted')
  await expect(card.getByTestId('signin-use-password')).toHaveCount(0)
  const sent = host.commands.filter((c) => c.cmd.kind === 'assistant.signin').map((c) => c.cmd)
  expect(sent.at(-1)).toEqual({
    kind: 'assistant.signin',
    agent: 'astra',
    messageId: 'astra-1-a1',
    url: URL,
    username: 'isaac@example.com',
    password: 'right',
  })

  // Eva's browser: her live screen as a page tab beside the chat, one tab however often it is asked for.
  await card.getByTestId('signin-open-browser').click()
  await expect(pageTabs(shell)).toHaveCount(1)
  await expect.poll(() => browserTabs(app)).toEqual([EVA_COMPUTER_URL])
  await card.getByTestId('signin-open-browser').click()
  await expect(pageTabs(shell)).toHaveCount(1)
  expect(await browserTabs(app)).toEqual([EVA_COMPUTER_URL])
  // Live, the Selkies stream needs a few seconds before its first frame.
  if (process.env.EVA_SCREEN === '1') await shell.waitForTimeout(10_000)
  await shot(app, shell, 'browser')
})
