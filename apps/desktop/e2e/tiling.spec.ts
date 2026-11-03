import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect, launchApp } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { startStaticServer, type StaticServer } from './helpers/static-server'

// The window's panes are one global split tree: the chat pane and tool panes holding tool tabs.
// Browser, Files and Artifacts show what belongs to the page in front (its browser scope):
// each chat owns its browser tabs, pinned tabs show everywhere.

type Snap = {
  tabs: Array<{ id: string; title: string; pinned: boolean }>
  activeId: string
  scope: string
}
type G = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
    hooks: { browser: { host: { snapshot(): Snap } } }
  }
}
type ShellHooks = {
  __evaosShell: {
    openPlace(page: string, newTab?: boolean, extra?: object): void
    openChat(): void
    browserScope(): string
  }
}
/** A tool pane on screen: its id, tab ids in order, and the tab in front. */
type PaneView = { id: string; tabs: string[]; active: string | null }

let server: StaticServer
let fx: ChatFixture

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    // Chat A carries a link to the test page, so it opens the way Isaac opens one.
    await fx.append(
      'p4-ecard',
      JSON.stringify({
        type: 'message',
        id: 'a9',
        parentId: 'a1',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: `See [the page A link](${server.url('/a.html')}).` }],
          stopReason: 'stop',
        },
      }),
    )
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5' })
    fx.cleanup()
  },
})

test.use({ startOnChat: false })

test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const sel = (id: string): string => `[data-testid="${id}"]`
const host = (app: ElectronApplication): Promise<Snap> =>
  app.evaluate(() => (globalThis as unknown as G).__evaosTest.hooks.browser.host.snapshot())
const scope = (shell: Page): Promise<string> =>
  shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.browserScope())
const stripIds = (shell: Page): Promise<string[]> =>
  shell
    .locator('[data-testid^=browser-tab-t]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')!.slice('browser-tab-'.length)),
    )

/** The tool panes on screen (a hidden or zoomed-away pane has no frame size). */
const panes = (shell: Page): Promise<PaneView[]> =>
  shell.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-pane-kind=tool]')]
      .filter((f) => f.style.display !== 'none')
      .map((f) => {
        const tabs = [...f.querySelectorAll<HTMLElement>('[data-pane-tab]')].map((t) =>
          t.getAttribute('data-testid')!.slice('pane-tab-'.length),
        )
        const active = f.querySelector('[data-pane-tab][data-active]')
        return {
          id: f.dataset['paneId']!,
          tabs,
          active: active ? active.getAttribute('data-testid')!.slice('pane-tab-'.length) : null,
        }
      }),
  )

const layoutFile = (dir: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}
type SavedNode =
  | { type: 'pane'; id: string; tabs: Array<{ kind: string }>; active: string | null }
  | { type: 'split'; id: string; dir: 'row' | 'column'; sizes: number[]; children: SavedNode[] }
/** The saved tree as nested ids: a pane is its id, a split is [dir, ...children]. */
function shape(node: SavedNode): unknown {
  return node.type === 'pane' ? node.id : [node.dir, ...node.children.map(shape)]
}
const savedShape = (dir: string): unknown => {
  const t = layoutFile(dir)['tiling'] as { root?: SavedNode } | undefined
  return t?.root ? shape(t.root) : null
}

async function openChat(shell: Page, file: string): Promise<void> {
  await shell.evaluate(
    (f) => (window as unknown as ShellHooks).__evaosShell.openPlace('chat', false, { chat: f }),
    file,
  )
  await expect.poll(() => scope(shell)).toBe(`chat:${file}`)
}
async function openPage(shell: Page, page: string): Promise<void> {
  await shell.evaluate((p) => (window as unknown as ShellHooks).__evaosShell.openPlace(p), page)
  await expect.poll(() => scope(shell)).toBe(`page:${page}`)
}
async function typeAddress(shell: Page, url: string): Promise<void> {
  const addr = shell.locator(sel('address-input'))
  await addr.fill(url)
  await addr.press('Enter')
}
async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}
async function box(shell: Page, selector: string) {
  const b = await shell.locator(selector).boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}
/** Where to press a tool tab to drag it, scrolled into its strip's view first. */
async function grab(shell: Page, tab: string): Promise<{ x: number; y: number }> {
  await shell.locator(sel(`pane-tab-${tab}`)).scrollIntoViewIfNeeded()
  const b = await box(shell, sel(`pane-tab-${tab}`))
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
/** Picks a pane's + menu item (split right, split down, maximize). */
async function paneMenu(shell: Page, pane: string, item: string): Promise<void> {
  await shell.locator(sel(`pane-add-${pane}`)).click()
  await shell.locator(`${sel(`pane-add-menu-${pane}`)} ${sel(item)}`).click()
}

const DEFAULT: PaneView[] = [{ id: 'p2', tabs: ['browser', 'files'], active: 'browser' }]

test('one global tree: tool tabs follow the page in front, the toggle hides and shows them', async ({
  app,
  shell,
  configDir,
}) => {
  const tools = shell.locator(sel('pane-p2'))
  const toggle = shell.locator(`${sel('panel-toggle')}:visible`).first()
  const chatA = fx.file('p4-ecard')
  const chatB = fx.file('p4-relay')

  // A fresh config: the chat on the left, one tool pane with Browser in front on the right.
  await expect(shell.locator(sel('pane-chat'))).toHaveAttribute('data-pane-kind', 'chat')
  await expect(tools).toBeVisible()
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  await expect(shell.locator(sel('pane-tab-browser'))).toHaveAttribute('role', 'tab')
  const chatBox = await box(shell, sel('pane-chat'))
  const toolBox = await box(shell, sel('pane-p2'))
  expect(toolBox.x).toBeGreaterThan(chatBox.x + chatBox.width)
  await expect(shell.locator(sel('divider-s1-0'))).toBeVisible()
  // The first save writes the tree and drops the old panel keys.
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'chat', 'p2'])
  expect(layoutFile(configDir)).not.toHaveProperty('panel_choices')
  expect(layoutFile(configDir)).not.toHaveProperty('panel_tool')

  // Chat A, with Files in front and the tool panes hidden: a link opens a browser tab there,
  // which shows the tool panes and brings the Browser tab forward.
  await openChat(shell, chatA)
  await shell.locator(sel('pane-tab-files')).click()
  await expect(shell.locator(sel('pane-tab-files'))).toHaveAttribute('data-active', 'true')
  await expect(shell.locator(`${sel('pane-body-p2')} ${sel('files-panel')}`)).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAttribute('aria-label', 'Show tool panes')
  await expect(tools).toBeHidden()
  await shell.locator(sel('chat-log')).getByText('the page A link').click()
  await expect(tools).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAttribute('aria-label', 'Hide tool panes')
  await expect(shell.locator(sel('pane-tab-browser'))).toHaveAttribute('data-active', 'true')
  await expect(shell.locator(`${sel('pane-body-p2')} ${sel('browser-panel')}`)).toBeVisible()
  await expect(shell.locator('[data-testid^=browser-tab-t]')).toHaveCount(1)
  await expect(shell.locator('[data-testid^=browser-tab-t]').first()).toContainText('Page A')
  const aTab = (await host(app)).activeId
  expect((await host(app)).scope).toBe(`chat:${chatA}`)

  // Chat B has no tabs: the tree stays as it is, the browser shows B's (empty) strip.
  await openChat(shell, chatB)
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  await expect.poll(async () => (await host(app)).tabs).toEqual([])
  await expect.poll(() => stripIds(shell)).toEqual([])
  await expect(shell.locator(sel('page-blank'))).toBeVisible()
  // A tab opened in B (Isaac types an address) belongs to B.
  await typeAddress(shell, server.url('/b.html'))
  await expect(shell.locator('[data-testid^=browser-tab-t]').first()).toContainText('Page B')
  const bTab = (await host(app)).activeId
  expect(bTab).not.toBe(aTab)

  // Back to A: its tab is active again and B's is not there.
  await openChat(shell, chatA)
  await expect.poll(() => stripIds(shell)).toEqual([aTab])
  expect((await host(app)).activeId).toBe(aTab)
  await expect(shell.locator(sel(`browser-tab-${aTab}`))).toHaveClass(/is-active/)

  // Pin A's tab from the strip's menu: B shows it first and keeps its own active tab.
  await shell.locator(sel(`browser-tab-${aTab}`)).click({ button: 'right' })
  await shell.locator(sel('browser-tab-menu-pin')).click()
  await expect(shell.locator(sel(`browser-tab-pin-${aTab}`))).toBeVisible()
  await openChat(shell, chatB)
  await expect.poll(() => stripIds(shell)).toEqual([aTab, bTab])
  expect((await host(app)).activeId).toBe(bTab)

  // Hiding is global: it holds across chats and pages, and Cmd+Shift+B brings the panes back.
  await toggle.click()
  await expect(tools).toBeHidden()
  await openChat(shell, chatA)
  await expect(tools).toBeHidden()
  await openPage(shell, 'dashboard')
  await expect(tools).toBeHidden()
  await shell.locator(sel('shell')).click({ position: { x: 600, y: 790 } })
  await shell.keyboard.press('Meta+Shift+b')
  await expect(tools).toBeVisible()
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)

  // Dashboard is its own scope: only the pinned tab, and + opens a Dashboard tab.
  await expect
    .poll(async () => (await host(app)).tabs.map((t) => [t.id, t.pinned]))
    .toEqual([[aTab, true]])
  await shell.locator(sel('browser-tab-new')).click()
  await expect.poll(async () => (await host(app)).tabs.length).toBe(2)
  await typeAddress(shell, server.url('/b.html'))
  await expect.poll(() => stripIds(shell)).toHaveLength(2)
  const dashTab = (await host(app)).activeId
  await openChat(shell, chatB)
  await expect.poll(async () => (await host(app)).tabs.map((t) => t.id)).toEqual([aTab, bTab])
  await openPage(shell, 'dashboard')
  await expect.poll(() => stripIds(shell)).toEqual([aTab, dashTab])

  // A draft chat opens a tab, then omp names its file: the tab stays with the chat.
  const before = fs.readdirSync(fx.sessionsDir)
  await shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.openChat())
  await expect.poll(() => scope(shell)).toMatch(/^draft:\d+$/)
  await expect(tools).toBeVisible()
  await shell.locator(sel('browser-tab-new')).click()
  await expect.poll(async () => (await host(app)).tabs.length).toBe(2)
  await typeAddress(shell, server.url('/a.html'))
  await expect.poll(async () => (await host(app)).tabs[1]?.title).toBe('Page A')
  const draftTab = (await host(app)).activeId
  const input = shell.locator(sel('composer-input'))
  await expect(input).toBeVisible()
  await input.fill('hello from a draft')
  await input.press('Enter')
  await expect
    .poll(() => fs.readdirSync(fx.sessionsDir).filter((n) => !before.includes(n)).length)
    .toBe(1)
  const created = path.join(
    fx.sessionsDir,
    fs.readdirSync(fx.sessionsDir).find((n) => !before.includes(n))!,
  )
  await expect.poll(() => scope(shell)).toBe(`chat:${created}`)
  await expect.poll(async () => (await host(app)).scope).toBe(`chat:${created}`)
  expect((await host(app)).activeId).toBe(draftTab)
  await openChat(shell, chatA)
  await openChat(shell, created)
  await expect.poll(() => stripIds(shell)).toEqual([aTab, draftTab])
  expect((await host(app)).activeId).toBe(draftTab)

  // A renderer reload re-syncs with the host's scopes: same scope, same tabs, same tree.
  await shell.reload()
  await shell.waitForSelector(sel('rail'))
  await shell.waitForFunction(() => Boolean((window as unknown as ShellHooks).__evaosShell))
  await expect.poll(() => scope(shell)).toBe(`chat:${created}`)
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  await expect.poll(() => stripIds(shell)).toEqual([aTab, draftTab])
  expect((await host(app)).scope).toBe(`chat:${created}`)
  await openChat(shell, chatB)
  await expect.poll(() => stripIds(shell)).toEqual([aTab, bTab])

  // With every tool pane closed, the toggle opens Browser and Files again.
  await shell.locator(sel('pane-close-p2')).click()
  await expect.poll(() => panes(shell)).toEqual([])
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => savedShape(configDir)).toEqual('chat')
  await toggle.click()
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p3', tabs: ['browser', 'files'], active: 'browser' }])
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => stripIds(shell)).toEqual([aTab, bTab])
})

test('the + menu splits a pane right and down, and maximizes one', async ({
  app,
  shell,
  configDir,
}) => {
  await size(app, shell, 1600, 900)
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  await paneMenu(shell, 'p2', 'pane-split-p2')
  await expect
    .poll(() => panes(shell))
    .toEqual([
      { id: 'p2', tabs: ['files'], active: 'files' },
      { id: 'p3', tabs: ['browser'], active: 'browser' },
    ])
  await expect(shell.locator(`${sel('pane-body-p3')} ${sel('browser-panel')}`)).toBeVisible()
  const p2 = await box(shell, sel('pane-p2'))
  const p3 = await box(shell, sel('pane-p3'))
  expect(p3.x).toBeGreaterThan(p2.x + p2.width)
  expect(Math.abs(p3.width - p2.width)).toBeLessThanOrEqual(2)
  // Same-direction splits flatten: the row now has three children and two dividers.
  await expect(shell.locator(sel('divider-s1-0'))).toBeVisible()
  await expect(shell.locator(sel('divider-s1-1'))).toBeVisible()
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'chat', 'p2', 'p3'])

  // Dragging the divider after the chat gives its space to the pane beside it; the last pane
  // keeps its width.
  const chat = await box(shell, sel('pane-chat'))
  const d = await box(shell, sel('divider-s1-0'))
  const x = d.x + d.width / 2
  const y = d.y + d.height / 2
  await shell.mouse.move(x, y)
  await shell.mouse.down()
  await shell.mouse.move(x - 20, y, { steps: 3 })
  await shell.mouse.move(x - 40, y, { steps: 3 })
  await shell.mouse.up()
  await expect
    .poll(async () => Math.round((await box(shell, sel('pane-p2'))).width - p2.width))
    .toBe(40)
  expect(Math.round(chat.width - (await box(shell, sel('pane-chat'))).width)).toBe(40)
  expect(Math.round((await box(shell, sel('pane-p3'))).width)).toBe(Math.round(p3.width))

  // Maximize fills the panes' area with one pane; its header button restores the others.
  await paneMenu(shell, 'p3', 'pane-zoom-p3')
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p3', tabs: ['browser'], active: 'browser' }])
  await expect(shell.locator(sel('pane-chat'))).toBeHidden()
  const restore = shell.locator(`${sel('pane-header-p3')} ${sel('pane-zoom-p3')}`)
  await expect(restore).toHaveAttribute('aria-label', 'Restore panes')
  await restore.click()
  await expect.poll(async () => (await panes(shell)).map((p) => p.id)).toEqual(['p2', 'p3'])
  await expect(shell.locator(sel('pane-chat'))).toBeVisible()

  // Splitting a pane with one tab opens a tool that is not open anywhere: none is left here.
  await paneMenu(shell, 'p3', 'pane-split-p3')
  await expect.poll(async () => (await panes(shell)).map((p) => p.id)).toEqual(['p2', 'p3'])
})

test('dragging a tab onto a pane edge makes a new pane, and the tree survives a restart', async ({
  app,
  shell,
  configDir,
}) => {
  await size(app, shell, 1400, 900)
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)

  // Drag Files to the chat pane's bottom edge: the drop zone shows the half it would take.
  const { x: sx, y: sy } = await grab(shell, 'files')
  const chat = await box(shell, sel('pane-chat'))
  await shell.mouse.move(sx, sy)
  await shell.mouse.down()
  // Below the start distance it is still a click.
  await shell.mouse.move(sx + 3, sy)
  await expect(shell.locator(sel('drop-zone'))).toHaveCount(0)
  const tx = chat.x + chat.width / 2
  const ty = chat.y + chat.height - 24
  await shell.mouse.move(tx, ty, { steps: 12 })
  const zone = shell.locator(sel('drop-zone'))
  await expect(zone).toBeVisible()
  await expect(zone).toHaveAttribute('data-zone', 'down')
  const z = await box(shell, sel('drop-zone'))
  expect(Math.abs(z.y + z.height - (chat.y + chat.height))).toBeLessThanOrEqual(2)
  expect(Math.abs(z.height - chat.height / 2)).toBeLessThanOrEqual(2)
  await shell.mouse.up()
  await expect(zone).toHaveCount(0)

  const after: PaneView[] = [
    { id: 'p3', tabs: ['files'], active: 'files' },
    { id: 'p2', tabs: ['browser'], active: 'browser' },
  ]
  await expect
    .poll(async () => (await panes(shell)).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual([...after].sort((a, b) => a.id.localeCompare(b.id)))
  const chat2 = await box(shell, sel('pane-chat'))
  const p3 = await box(shell, sel('pane-p3'))
  expect(p3.y).toBeGreaterThan(chat2.y + chat2.height)
  expect(Math.abs(p3.x - chat2.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(p3.width - chat2.width)).toBeLessThanOrEqual(1)
  await expect.poll(() => savedShape(configDir)).toEqual(['row', ['column', 'chat', 'p3'], 'p2'])

  // Drag Browser onto the middle of the new pane: it joins that pane's tabs, and its own pane goes.
  const browser = await grab(shell, 'browser')
  const body = await box(shell, sel('pane-body-p3'))
  await shell.mouse.move(browser.x, browser.y)
  await shell.mouse.down()
  await shell.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 12 })
  await expect(shell.locator(sel('drop-zone'))).toHaveAttribute('data-zone', 'center')
  await shell.mouse.up()
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p3', tabs: ['files', 'browser'], active: 'browser' }])
  await expect
    .poll(() => {
      const t = layoutFile(configDir)['tiling'] as { root?: SavedNode } | undefined
      const p3n = t?.root ? findSaved(t.root, 'p3') : null
      return p3n?.type === 'pane' ? p3n.tabs.map((x) => x.kind) : null
    })
    .toEqual(['files', 'browser'])
  const want = await panes(shell)
  await app.close()

  // The same config dir brings the same tree back.
  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector(sel('rail'), { state: 'attached' })
    await page.waitForSelector(sel('pane-p3'), { state: 'attached' })
    await expect
      .poll(async () => (await panes(page)).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...want].sort((a, b) => a.id.localeCompare(b.id)))
    const c = await box(page, sel('pane-chat'))
    const n = await box(page, sel('pane-p3'))
    expect(n.y).toBeGreaterThan(c.y + c.height)
    expect(savedShape(configDir)).toEqual(['column', 'chat', 'p3'])
  } finally {
    await app2.close()
  }
})

function findSaved(node: SavedNode, id: string): SavedNode | null {
  if (node.id === id) return node
  if (node.type === 'pane') return null
  for (const c of node.children) {
    const hit = findSaved(c, id)
    if (hit) return hit
  }
  return null
}
