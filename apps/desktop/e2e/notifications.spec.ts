import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// Desktop notifications (main/notifications). In e2e runs the main process records them instead of
// showing them (a stand-in for Electron's Notification, so no banner lands on Isaac's screen and no
// window is raised). A fake Relay host lists Nova's thread, a waiting item and a canvas room; the
// thread file is written like omp writes it.
//
// What it proves: a reply notifies once under its assistant, and its click opens that thread; a
// hidden "(nothing to report)" reply does not; a question waiting on Isaac and a live canvas room
// notify; ten idle minutes silence everything (the phone has it); a focused window showing the
// thread stays quiet; Settings > Notifications mutes one assistant and switches everything off,
// and saves both.

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
        agents: [
          { id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' },
          { id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'astra-2' },
        ],
      }),
    )
    // Nova's thread already holds a reply when the app starts: the baseline, not news.
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-27T20-00-00-000Z_nova-1.jsonl'),
      [
        line({ type: 'session', version: 3, id: 'nova-1', timestamp: new Date().toISOString() }),
        line({
          type: 'message',
          id: 'u1',
          parentId: null,
          message: { role: 'user', content: 'Hi' },
        }),
        reply('a1', 'u1', 'Hello Isaac.'),
      ].join('\n') + '\n',
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.upsert(NOVA_THREAD)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)
const NOVA_THREAD: HostSession = {
  id: 'nova-1',
  status: 'idle',
  kind: 'assistant',
  assistant: 'nova',
  title: 'Nova',
}

interface Shown {
  groupId: string
  title: string
  body: string
  silent: boolean
}
interface Stub {
  log: Array<Shown & { click(): void }>
  state: { idle: number; focused: boolean }
}
type TestGlobal = { __evaosTest: { hooks: { notifications: Stub } } }
interface Hooks {
  openPlace(page: string, newTab?: boolean, extra?: { settingsSection: string }): void
}
type W = { __evaosShell?: Hooks }

const shown = (app: ElectronApplication): Promise<Shown[]> =>
  app.evaluate(() => {
    const stub = (globalThis as unknown as TestGlobal).__evaosTest.hooks.notifications
    return stub.log.map(({ groupId, title, body, silent }) => ({ groupId, title, body, silent }))
  })
const titles = async (app: ElectronApplication): Promise<string[]> =>
  (await shown(app)).map((n) => n.title)
const click = (app: ElectronApplication, i: number): Promise<void> =>
  app.evaluate((_e, n) => {
    ;(globalThis as unknown as TestGlobal).__evaosTest.hooks.notifications.log[n]!.click()
  }, i)
const setState = (app: ElectronApplication, patch: Partial<Stub['state']>): Promise<void> =>
  app.evaluate((_e, p) => {
    Object.assign((globalThis as unknown as TestGlobal).__evaosTest.hooks.notifications.state, p)
  }, patch)

const reply = (id: string, parent: string, text: string): string =>
  line({
    type: 'message',
    id,
    parentId: parent,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
  })

const openPlace = (shell: Page, page: string, section?: string): Promise<void> =>
  shell.evaluate(
    ([p, s]) =>
      (window as unknown as W).__evaosShell!.openPlace(
        p!,
        false,
        s === undefined ? undefined : { settingsSection: s },
      ),
    [page, section],
  )

const saved = (dir: string): { enabled: boolean; muted: string[] } =>
  JSON.parse(fs.readFileSync(path.join(dir, 'notifications.json'), 'utf8')) as {
    enabled: boolean
    muted: string[]
  }

test('replies, questions and canvases notify under the rules; settings mute and switch off', async ({
  app,
  shell,
  configDir,
}) => {
  await shell.waitForFunction(() => Boolean((window as unknown as W).__evaosShell))
  // Nova's thread is listed with its first reply: the baseline, not news.
  await shell.locator(sel('nav-assistants')).click()
  await expect(shell.locator(sel('sidebar-agent-nova'))).toBeVisible()
  await shell.waitForTimeout(500)
  expect(await shown(app)).toEqual([])

  // 1. A new reply: one notification under Nova with its text; the click opens Nova's page.
  await fx.append('nova-1', reply('a2', 'a1', 'Booked the dentist for Friday at 3.'))
  await expect
    .poll(() => shown(app))
    .toEqual([
      {
        groupId: 'assistant:nova',
        title: 'Nova',
        body: 'Booked the dentist for Friday at 3.',
        silent: false,
      },
    ])
  await click(app, 0)
  await expect(shell.locator(sel('agent-crumb'))).toBeVisible()

  // 2. A background turn answered "(nothing to report)" is no reply.
  await fx.append('nova-1', reply('a3', 'a2', '(nothing to report)'))
  await shell.waitForTimeout(800)
  expect(await titles(app)).toEqual(['Nova'])

  // 3. A question waiting on Isaac, from the Working list: once, with its question.
  host.setActivity([
    {
      id: 'session:ask1',
      kind: 'session',
      owner: 'assistant:astra',
      title: 'ENG-6630 auto-work',
      status: 'waiting',
      intent: 'Merge the PR?',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      open: { to: 'chat', thread: 'assistant:astra', session: 'ask1' },
    },
  ])
  await expect.poll(() => titles(app)).toEqual(['Nova', 'ENG-6630 auto-work is waiting on you'])
  expect((await shown(app))[1]).toMatchObject({ groupId: 'assistant:astra', body: 'Merge the PR?' })

  // 4. A live canvas room (the Join card).
  host.setCanvasRooms([
    {
      id: 'room-1',
      slug: 'mind-map',
      board: 'Mind map',
      live: true,
      agent: { name: 'Nova', color: '#7048e8' },
      chat: { assistant: 'nova', title: 'Sketch the onboarding flow' },
      humans: [],
      startedAt: Date.now(),
    },
  ])
  await expect.poll(() => titles(app)).toContain('Join Nova on Mind map')
  const before = (await shown(app)).length

  // 5. Ten idle minutes: this Mac stays quiet (the phone has it) until the next input.
  await setState(app, { idle: 601 })
  await fx.append('nova-1', reply('a4', 'a3', 'Away reply.'))
  await shell.waitForTimeout(800)
  expect((await shown(app)).length).toBe(before)
  await setState(app, { idle: 0 })

  // 6. A focused window with Nova's page in front stays quiet for Nova.
  await setState(app, { focused: true })
  await fx.append('nova-1', reply('a5', 'a4', 'You are looking at me.'))
  await shell.waitForTimeout(800)
  expect((await shown(app)).length).toBe(before)
  await setState(app, { focused: false })

  // 7. Settings > Notifications: mute Nova (saved, and Nova stays quiet), then switch off.
  await openPlace(shell, 'settings', 'Notifications')
  await expect(shell.locator(sel('settings-notifications'))).toBeVisible()
  const nova = shell.locator(sel('settings-notifications-assistant-nova'))
  await expect(nova).toBeChecked()
  await nova.click({ force: true })
  await expect.poll(() => saved(configDir)).toEqual({ enabled: true, muted: ['nova'] })
  await fx.append('nova-1', reply('a6', 'a5', 'Muted reply.'))
  await shell.waitForTimeout(800)
  expect((await shown(app)).length).toBe(before)

  await shell.locator(sel('settings-notifications-enabled')).click({ force: true })
  await expect.poll(() => saved(configDir)).toEqual({ enabled: false, muted: ['nova'] })
  await expect(nova).toBeDisabled()
  host.setActivity([
    {
      id: 'session:ask2',
      kind: 'session',
      owner: 'assistant:astra',
      title: 'Second question',
      status: 'waiting',
      intent: 'Ship it?',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      open: { to: 'chat', thread: 'assistant:astra', session: 'ask2' },
    },
  ])
  await shell.waitForTimeout(800)
  expect((await shown(app)).length).toBe(before)

  // The Send test button shows one past every rule.
  await shell.locator(sel('settings-notifications-test')).click()
  await expect.poll(() => titles(app)).toContain('Relay notifications are on')
})
