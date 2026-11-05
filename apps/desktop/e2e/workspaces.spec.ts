import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect, launchApp } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// Each workspace (an assistant with everything it owns, a plain chat, a page) keeps its own panes.
// Switching swaps the whole layout and switching back restores it; an agent's tab opens in its
// own workspace without showing, and that workspace's sidebar row gets a quiet dot until Isaac
// goes there; a pinned tab shows in every workspace; layouts survive a restart; the one window
// layout of an older build becomes the front workspace's. Proof in proof/per-chat-panes/.

let fx: ChatFixture
let host: FakeRelayHost
let env: Record<string, string>
const line = (o: unknown): string => JSON.stringify(o)

function thread(dir: string, id: string, cwd: string, text: string): void {
  fs.writeFileSync(
    path.join(dir, `2026-11-05T09-00-00-000Z_${id}.jsonl`),
    [
      line({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd }),
      line({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: text } }),
    ].join('\n') + '\n',
  )
}

const test = base.extend<{ seed: Record<string, unknown> | null }>({
  seed: [null, { option: true }],
  launchEnv: async ({ configDir, seed }, use) => {
    if (seed) fs.writeFileSync(path.join(configDir, 'layout.json'), JSON.stringify(seed))
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [
          { id: 'astra', title: 'Astra', scope: 'Work', avatar: 'astra-1' },
          { id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'nova-1' },
        ],
      }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    thread(fx.sessionsDir, 'astra-1', evaRoot, 'Hi Astra')
    thread(fx.sessionsDir, 'nova-1', evaRoot, 'Hi Nova')
    for (const a of ['astra', 'nova']) {
      host.upsert({ id: `${a}-1`, status: 'idle', kind: 'assistant', assistant: a, title: a })
    }
    env = { ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir }
    await use(env)
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Hooks = { __evaosShell: { openPlace(page: string, newTab?: boolean): void; openChat(): void } }

const open = (shell: Page, page: string): Promise<void> =>
  shell.evaluate((p) => (window as unknown as Hooks).__evaosShell.openPlace(p), page)

const ControlFile = z.object({ url: z.string(), token: z.string() })
const Reply = z.object({ ok: z.boolean(), value: z.unknown().optional(), message: z.string().optional() })
const Layout = z.object({
  workspace: z.string(),
  shown: z.boolean(),
  panes: z.array(z.string()),
  root: z.unknown(),
})

/** One agent action the way relay-ctl sends it: the caller's scope rides along. */
async function agent(
  configDir: string,
  id: string,
  params: Record<string, unknown>,
  scope?: string,
): Promise<unknown> {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { url, token } = ControlFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  const res = await fetch(`${url}/actions/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params, ...(scope ? { scope } : {}) }),
  })
  const r = Reply.parse(await res.json())
  if (!r.ok) throw new Error(`${id}: ${r.message}`)
  return r.value
}

const layout = async (configDir: string, scope: string) =>
  Layout.parse(await agent(configDir, 'layout.read', {}, scope))

/** Tool tab ids on screen, pane by pane. */
const toolTabs = (shell: Page): Promise<string[][]> =>
  shell.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-pane-kind=tool]')].map((p) =>
      [...p.querySelectorAll<HTMLElement>('[data-pane-tab]')].map(
        (t) => t.dataset['testid']?.replace(/^pane-tab-/, '') ?? '',
      ),
    ),
  )

async function shot(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  await proofShot(app, shell, name, { phase: 'per-chat-panes' })
}

test('each assistant keeps its own panes; an agent opens into its own workspace with a quiet dot', async ({
  app,
  shell,
  configDir,
}) => {
  await open(shell, 'agent:astra')
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Astra', { timeout: 10_000 })
  // Astra's workspace: Files right of her thread, a Terminal below it.
  await agent(configDir, 'tab.open', { kind: 'files' }, 'agent:astra')
  await agent(configDir, 'pane.split', { dir: 'down', tab: { kind: 'terminal' } }, 'agent:astra')
  await expect.poll(() => toolTabs(shell)).toEqual([['files'], ['terminal']])
  const astra = await layout(configDir, 'agent:astra')
  expect(astra).toMatchObject({ workspace: 'page:agent:astra', shown: true })
  await shot(app, shell, 'astra-workspace')

  // Nova has her own: none of Astra's panes follow her.
  await open(shell, 'agent:nova')
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Nova', { timeout: 10_000 })
  await expect.poll(() => toolTabs(shell)).toEqual([])
  await shot(app, shell, 'nova-workspace')

  // Astra opens Test Bench beside her thread while Isaac reads Nova: nothing pops over Nova.
  const r = await agent(
    configDir,
    'tab.open',
    { kind: 'page', args: { page: 'test-bench' } },
    'agent:astra',
  )
  expect(r).toMatchObject({ scope: 'page:agent:astra', background: true })
  await expect.poll(() => toolTabs(shell)).toEqual([])
  const away = await layout(configDir, 'agent:astra')
  expect(away).toMatchObject({ shown: false })
  expect(JSON.stringify(away.root)).toContain('view:page:test-bench')
  // A quiet dot on Astra's sidebar row, none on Nova's.
  await shell.locator(sel('nav-assistants')).click()
  await expect(shell.locator(sel('sidebar-dot-astra'))).toBeVisible()
  await expect(shell.locator(sel('sidebar-dot-nova'))).toHaveCount(0)
  await shot(app, shell, 'background-dot')

  // Back to Astra: her panes exactly as they were, Test Bench waiting, the dot gone.
  await shell.locator(sel('sidebar-agent-astra')).click()
  await expect.poll(async () => (await toolTabs(shell)).flat()).toContain('view:page:test-bench')
  const back = await layout(configDir, 'agent:astra')
  expect(back.panes).toEqual(away.panes)
  await expect(shell.locator(sel('sidebar-dot-astra'))).toHaveCount(0)
  await shot(app, shell, 'astra-restored')
})

test('a pinned tab shows in every workspace; a new chat starts with just the pinned tabs', async ({
  app,
  shell,
  configDir,
}) => {
  await open(shell, 'agent:nova')
  await agent(configDir, 'tab.open', { kind: 'files' }, 'agent:nova')
  await agent(configDir, 'pane.split', { dir: 'down', tab: { kind: 'terminal' } }, 'agent:nova')
  const files = shell.locator(sel('pane-tab-files'))
  await files.click({ button: 'right' })
  await shell.locator(sel('pane-tab-menu-pin')).click()
  await expect(files).toHaveAttribute('data-pinned', 'true')

  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.openChat())
  await expect(shell.locator(sel('composer-input'))).toBeVisible()
  await expect.poll(() => toolTabs(shell)).toEqual([['files']])
  await shot(app, shell, 'pinned-in-new-chat')

  await open(shell, 'agent:astra')
  await expect.poll(() => toolTabs(shell)).toEqual([['files']])
  await open(shell, 'agent:nova')
  await expect.poll(async () => (await toolTabs(shell)).flat().sort()).toEqual(['files', 'terminal'])
})

test('layouts persist per workspace across a restart', async ({ app, shell, configDir }) => {
  await open(shell, 'agent:astra')
  await agent(configDir, 'tab.open', { kind: 'terminal' }, 'agent:astra')
  await open(shell, 'agent:nova')
  await agent(configDir, 'tab.open', { kind: 'files' }, 'agent:nova')
  await expect.poll(() => toolTabs(shell)).toEqual([['files']])
  // The layout is written a moment after a change.
  const file = path.join(configDir, 'layout.json')
  await expect
    .poll(() => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).workspaces?.layouts ?? {}))
    .toEqual(expect.arrayContaining(['page:agent:astra', 'page:agent:nova']))
  await app.close()

  const again = await launchApp(configDir, env)
  try {
    const page = await again.firstWindow()
    await page.waitForSelector('[data-pane-kind=app]')
    await expect.poll(() => toolTabs(page)).toEqual([['files']])
    await page.waitForFunction(() => Boolean((window as unknown as Partial<Hooks>).__evaosShell))
    await open(page, 'agent:astra')
    await expect.poll(() => toolTabs(page)).toEqual([['terminal']])
  } finally {
    await again.close()
  }
})

/** A layout.json from before workspaces (Isaac's shape on 2026-11-05): Nova in front. */
function windowLayout(): Record<string, unknown> {
  const place = (page: string, extra: Record<string, unknown> = {}) => ({
    page,
    chat: null,
    settings_section: 'Theme',
    meeting: null,
    canvas: null,
    ...extra,
  })
  const tab = (id: number, here: unknown, pinned = false) => ({ id, here, back: [], forward: [], pinned })
  const app = (id: string) => ({ id, contentComponent: 'app', tabComponent: 'app', params: {} })
  return {
    sidebar_width: 272,
    tabs: {
      active: 1,
      nextId: 65,
      list: [
        tab(0, place('agent:astra'), true),
        tab(44, place('agent:nova')),
        tab(64, place('canvas', { canvas: 'mind-map' })),
      ],
    },
    dock: {
      grid: {
        root: {
          type: 'branch',
          size: 800,
          data: [
            { type: 'leaf', size: 700, data: { id: 'p77', views: ['tab:0', 'tab:44'], activeView: 'tab:44' } },
            { type: 'leaf', size: 500, data: { id: 'p89', views: ['files', 'tab:64'], activeView: 'tab:64' } },
          ],
        },
        width: 1200,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: {
        'tab:0': app('tab:0'),
        'tab:44': app('tab:44'),
        files: { id: 'files', contentComponent: 'tool', tabComponent: 'tool', params: { tab: { kind: 'files' } } },
        'tab:64': app('tab:64'),
      },
    },
  }
}

test.describe('migration', () => {
  test.use({ seed: windowLayout() })

  test("the window's one layout becomes Nova's; the others start empty", async ({
    app,
    shell,
    configDir,
  }) => {
    await expect.poll(() => toolTabs(shell)).toEqual([['files', 'view:canvas:mind-map']])
    const nova = await layout(configDir, 'agent:nova')
    expect(nova).toMatchObject({ workspace: 'page:agent:nova', shown: true })
    // The board beside Nova is her page tab now, not an app tab of its own.
    const tabs = await shell.evaluate(() =>
      (
        window as unknown as { __evaosShell: { tabs(): { list: Array<{ id: number }> } } }
      ).__evaosShell
        .tabs()
        .list.map((t) => t.id),
    )
    expect(tabs).toEqual([0, 44])
    await shot(app, shell, 'migrated-nova')
    await open(shell, 'agent:astra')
    await expect.poll(() => toolTabs(shell)).toEqual([])
  })
})
