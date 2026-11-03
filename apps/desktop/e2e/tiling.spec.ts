import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect, launchApp } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { startStaticServer, type StaticServer } from './helpers/static-server'

// The window's panes are dockview groups (tiling/dock): app tabs (chats and pages) and tool tabs
// live in any pane. Browser and Files show what belongs to the app tab in front (its browser
// scope): each chat owns its browser tabs, pinned tabs show everywhere.

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
    tabs(): { list: Array<{ id: number; page: string }>; active: number }
  }
}
/** A pane on screen: its id, its tabs' panel ids in order (`tab:<n>` or a tool), the one in front. */
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

/** The panes on screen, `kind` only (a pane hidden by a maximized one is not on screen). */
const panes = (shell: Page, kind: 'app' | 'tool' | 'any' = 'tool'): Promise<PaneView[]> =>
  shell.evaluate(
    (k) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          k === 'any' ? '[data-pane-kind]' : `[data-pane-kind=${k}]`,
        ),
      ]
        .filter((f) => {
          const r = f.getBoundingClientRect()
          return f.checkVisibility({ visibilityProperty: true }) && r.width > 0 && r.height > 0
        })
        .map((f) => {
          const ids = (t: Element): string => {
            const app = t.getAttribute('data-app-tab')
            return app !== null
              ? `tab:${app}`
              : t.getAttribute('data-testid')!.slice('pane-tab-'.length)
          }
          const tabs = [...f.querySelectorAll('[data-pane-tab], .eva-tab[data-app-tab]')]
          const front = tabs.find(
            (t) => t.hasAttribute('data-active') && t.getAttribute('data-active') !== 'false',
          )
          return {
            id: f.dataset['paneId']!,
            tabs: tabs.map(ids),
            active: front ? ids(front) : null,
          }
        }),
    kind,
  )

type DockNode =
  { type: 'branch'; data: DockNode[] } | { type: 'leaf'; data: { id: string; views: string[] } }
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
/** The saved dock as nested ids: a pane is its id, a split is ['row' | 'column', ...children]. */
function shape(node: DockNode, dir: 'row' | 'column'): unknown {
  if (node.type === 'leaf') return node.data.id
  const turn = dir === 'row' ? 'column' : 'row'
  return [dir, ...node.data.map((c) => shape(c, turn))]
}
const savedDock = (dir: string) =>
  layoutFile(dir)['dock'] as
    { grid: { root: DockNode; orientation: 'HORIZONTAL' | 'VERTICAL' } } | undefined
const savedShape = (dir: string): unknown => {
  const d = savedDock(dir)
  return d ? shape(d.grid.root, d.grid.orientation === 'HORIZONTAL' ? 'row' : 'column') : null
}
/** The saved views of pane `id`. */
function savedViews(dir: string, id: string): string[] | null {
  const find = (n: DockNode): string[] | null => {
    if (n.type === 'leaf') return n.data.id === id ? n.data.views : null
    for (const c of n.data) {
      const hit = find(c)
      if (hit) return hit
    }
    return null
  }
  const d = savedDock(dir)
  return d ? find(d.grid.root) : null
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
/** Picks a pane's + menu item (split right, split down, maximize). */
async function paneMenu(shell: Page, pane: string, item: string): Promise<void> {
  await shell.locator(sel(`pane-add-${pane}`)).click()
  await shell.locator(`${sel(`pane-add-menu-${pane}`)} ${sel(item)}`).click()
}
/** The sash between two side-by-side panes. */
async function sashBetween(shell: Page, left: string, right: string) {
  const a = await box(shell, sel(`pane-${left}`))
  const b = await box(shell, sel(`pane-${right}`))
  const sashes = await shell.locator('.dv-sash').all()
  for (const s of sashes) {
    const r = await s.boundingBox()
    if (r && r.x >= a.x + a.width - 2 && r.x + r.width <= b.x + 2 && r.height > 0) return r
  }
  throw new Error(`no sash between ${left} and ${right}`)
}
/**
 * Drags `from` (a tab) to the point (x, y) with the mouse, in steps so dockview's drop overlay
 * follows, and answers the overlay's box just before the drop.
 */
async function dragTo(shell: Page, from: string, x: number, y: number) {
  const t = await box(shell, from)
  await shell.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(t.x + t.width / 2 + 6, t.y + t.height / 2 + 6, { steps: 3 })
  await shell.mouse.move(x, y, { steps: 16 })
  const overlay = shell.locator('.dv-drop-target-anchor, .dv-drop-target-selection').first()
  await expect(overlay).toBeVisible()
  // The overlay slides to the zone under the pointer: read it once it holds still.
  let zone = await overlay.boundingBox()
  await expect
    .poll(
      async () => {
        const now = await overlay.boundingBox()
        const still = JSON.stringify(now) === JSON.stringify(zone)
        zone = now
        return still
      },
      { intervals: [150] },
    )
    .toBe(true)
  await shell.mouse.up()
  return zone!
}

const DEFAULT: PaneView[] = [{ id: 'p2', tabs: ['browser', 'files'], active: 'browser' }]

test('tool tabs follow the app tab in front; the toggle hides and shows them', async ({
  app,
  shell,
  configDir,
}) => {
  const tools = shell.locator(sel('pane-p2'))
  const toggle = shell.locator(`${sel('panel-toggle')}:visible`).first()
  const chatA = fx.file('p4-ecard')
  const chatB = fx.file('p4-relay')

  // A fresh config: the app tabs on the left, one tool pane with Browser in front on the right.
  await expect(shell.locator(sel('pane-p1'))).toHaveAttribute('data-pane-kind', 'app')
  await expect(tools).toBeVisible()
  await expect(tools).toHaveAttribute('data-pane-kind', 'tool')
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  const appBox = await box(shell, sel('pane-p1'))
  const toolBox = await box(shell, sel('pane-p2'))
  expect(toolBox.x).toBeGreaterThan(appBox.x + appBox.width)
  // The sash sits in the gap between them.
  const sash = await sashBetween(shell, 'p1', 'p2')
  expect(sash.width).toBeGreaterThan(0)
  // The first save writes the dock and drops the old split tree and panel keys.
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'p1', 'p2'])
  expect(layoutFile(configDir)).not.toHaveProperty('tiling')
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

  // Chat B has no tabs: the panes stay as they are, the browser shows B's (empty) strip.
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

  // A renderer reload re-syncs with the host's scopes: same scope, same tabs, same panes.
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
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'p1'])
  await toggle.click()
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p3', tabs: ['browser', 'files'], active: 'browser' }])
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => stripIds(shell)).toEqual([aTab, bTab])
})

test('the + menu splits a pane right and down, the sash resizes, and maximize shows one', async ({
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
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'p1', 'p2', 'p3'])

  // Dragging the sash after the app pane gives its space to the pane beside it.
  const app1 = await box(shell, sel('pane-p1'))
  const s = await sashBetween(shell, 'p1', 'p2')
  const x = s.x + s.width / 2
  const y = s.y + s.height / 2
  await shell.mouse.move(x, y)
  await shell.mouse.down()
  await shell.mouse.move(x - 20, y, { steps: 3 })
  await shell.mouse.move(x - 40, y, { steps: 3 })
  await shell.mouse.up()
  await expect
    .poll(async () => Math.round(app1.width - (await box(shell, sel('pane-p1'))).width))
    .toBe(40)
  expect(Math.round((await box(shell, sel('pane-p2'))).width - p2.width)).toBe(40)

  // The + menu moves Files over to p3 (p2, left empty, goes); split down puts it under Browser.
  await shell.locator(sel('pane-add-p3')).click()
  await shell.locator(sel('pane-add-menu-p3')).getByRole('menuitem', { name: 'Files' }).click()
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p3', tabs: ['browser', 'files'], active: 'files' }])
  await paneMenu(shell, 'p3', 'pane-split-down-p3')
  await expect.poll(async () => (await panes(shell)).length).toBe(2)
  const [upper, lower] = await panes(shell)
  expect(upper).toEqual({ id: 'p3', tabs: ['browser'], active: 'browser' })
  expect(lower!.tabs).toEqual(['files'])
  const p3top = await box(shell, sel('pane-p3'))
  const under = await box(shell, sel(`pane-${lower!.id}`))
  expect(under.y).toBeGreaterThan(p3top.y + p3top.height)
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'p1', ['column', 'p3', lower!.id]])

  // Maximize fills the panes' area with one pane; its header button restores the others.
  await paneMenu(shell, 'p3', 'pane-zoom-p3')
  await expect
    .poll(() => panes(shell, 'any'))
    .toEqual([{ id: 'p3', tabs: ['browser'], active: 'browser' }])
  await expect(shell.locator(sel('pane-p1'))).toBeHidden()
  const restore = shell.locator(`${sel('pane-header-p3')} ${sel('pane-zoom-p3')}`)
  await expect(restore).toHaveAttribute('aria-label', 'Restore panes')
  await restore.click()
  await expect(shell.locator(sel('pane-p1'))).toBeVisible()
  await expect(shell.locator(sel(`pane-${lower!.id}`))).toBeVisible()

  // Splitting a pane with one tab opens a tool that is not open anywhere: none is left here.
  const count = (await panes(shell, 'any')).length
  await paneMenu(shell, 'p3', 'pane-split-p3')
  await expect.poll(async () => (await panes(shell, 'any')).length).toBe(count)
})

test('dragging a tool tab onto a pane edge makes a new pane, and the layout survives a restart', async ({
  app,
  shell,
  configDir,
}) => {
  await size(app, shell, 1400, 900)
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)

  // Drag Files to the app pane's bottom edge: the overlay shows the half it would take.
  const body = await box(shell, sel('pane-body-p1'))
  const zone = await dragTo(
    shell,
    sel('pane-tab-files'),
    body.x + body.width / 2,
    body.y + body.height - 24,
  )
  expect(Math.abs(zone.y + zone.height - (body.y + body.height))).toBeLessThanOrEqual(4)
  expect(Math.abs(zone.height - body.height / 2)).toBeLessThanOrEqual(4)

  await expect
    .poll(async () => (await panes(shell)).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual([
      { id: 'p2', tabs: ['browser'], active: 'browser' },
      { id: 'p3', tabs: ['files'], active: 'files' },
    ])
  const top = await box(shell, sel('pane-p1'))
  const below = await box(shell, sel('pane-p3'))
  expect(below.y).toBeGreaterThan(top.y + top.height)
  expect(Math.abs(below.x - top.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(below.width - top.width)).toBeLessThanOrEqual(1)
  await expect.poll(() => savedShape(configDir)).toEqual(['row', ['column', 'p1', 'p3'], 'p2'])

  // Drag Browser onto the middle of the new pane: it joins that pane's tabs, and its own pane goes.
  const p3 = await box(shell, sel('pane-body-p3'))
  await dragTo(shell, sel('pane-tab-browser'), p3.x + p3.width / 2, p3.y + p3.height / 2)
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p3', tabs: ['files', 'browser'], active: 'browser' }])
  await expect.poll(() => savedViews(configDir, 'p3')).toEqual(['files', 'browser'])
  const want = await panes(shell, 'any')
  await app.close()

  // The same config dir brings the same panes back.
  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector(sel('rail'), { state: 'attached' })
    await page.waitForSelector(sel('pane-p3'), { state: 'attached' })
    await expect.poll(() => panes(page, 'any')).toEqual(want)
    const c = await box(page, sel('pane-p1'))
    const n = await box(page, sel('pane-p3'))
    expect(n.y).toBeGreaterThan(c.y + c.height)
    expect(savedShape(configDir)).toEqual(['column', 'p1', 'p3'])
  } finally {
    await app2.close()
  }
})

test('dragging an app tab onto the pane edge splits the app tabs; each pane gets its own strip, and they come back after a restart', async ({
  app,
  shell,
  configDir,
}) => {
  await size(app, shell, 1400, 900)
  await shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.openPlace('jobs', true))
  // One pane of app tabs: one strip at the top, the window's.
  await expect(shell.locator(sel('tabbar'))).toHaveCount(1)
  const tabs = await panes(shell, 'app')
  expect(tabs).toHaveLength(1)
  const jobs = tabs[0]!.active!
  const body = await box(shell, sel('pane-body-p1'))
  const zone = await dragTo(
    shell,
    `${sel('tabbar')} [data-app-tab="${jobs.slice(4)}"]`,
    body.x + body.width - 24,
    body.y + body.height / 2,
  )
  // The overlay is the pane's right half.
  expect(Math.abs(zone.x + zone.width - (body.x + body.width))).toBeLessThanOrEqual(4)
  expect(Math.abs(zone.width - body.width / 2)).toBeLessThanOrEqual(4)
  await expect.poll(async () => (await panes(shell, 'app')).length).toBe(2)
  const byX = async (p: PaneView) => (await box(shell, sel(`pane-${p.id}`))).x
  const split = await panes(shell, 'app')
  const xs = await Promise.all(split.map(byX))
  const [left, right] = xs[0]! < xs[1]! ? split : [split[1]!, split[0]!]
  expect(left!.tabs).not.toContain(jobs)
  expect(right!.tabs).toEqual([jobs])
  // Each pane of app tabs now has its own strip; the first keeps the window's controls.
  await expect(shell.locator(sel('tabbar'))).toHaveCount(1)
  await expect(
    shell.locator(`${sel(`pane-header-${right!.id}`)} ${sel(`tab-${jobs.slice(4)}`)}`),
  ).toBeVisible()
  await expect(shell.locator(`${sel(`pane-body-${right!.id}`)} ${sel('page-jobs')}`)).toBeVisible()
  const want = await panes(shell, 'any')
  await expect.poll(() => savedViews(configDir, right!.id)).toEqual([jobs])
  await app.close()

  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector(sel(`pane-${right!.id}`), { state: 'attached' })
    await expect.poll(() => panes(page, 'any')).toEqual(want)
  } finally {
    await app2.close()
  }
})

test('Cmd-click in the sidebar opens the page in a side pane; the app tab in front stays', async ({
  shell,
}) => {
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  const before = await panes(shell, 'app')
  await shell.locator(sel('nav-jobs')).click({ modifiers: ['Meta'] })
  // Jobs is a tab of the pane right of the app tabs, in front there; the dashboard stays in front
  // of its own pane and keeps the scope.
  await expect
    .poll(async () => (await panes(shell, 'any')).find((p) => p.id === 'p2'))
    .toMatchObject({ tabs: ['browser', 'files', expect.stringMatching(/^tab:\d+$/)] })
  const p2 = (await panes(shell, 'any')).find((p) => p.id === 'p2')!
  expect(p2.active).toBe(p2.tabs[2])
  await expect(shell.locator(`${sel('pane-body-p2')} ${sel('page-jobs')}`)).toBeVisible()
  expect((await panes(shell, 'app')).find((p) => p.id === 'p1')).toEqual(before[0])
  await expect.poll(() => scope(shell)).toBe('page:dashboard')

  // With the tool panes hidden, Cmd-click splits a new pane off right of the app tabs.
  await shell
    .locator(`${sel('panel-toggle')}:visible`)
    .first()
    .click()
  await expect(shell.locator(sel('pane-p2'))).toBeHidden()
  await shell.locator(sel('nav-habits')).click({ modifiers: ['Meta'] })
  await expect(shell.locator(sel('page-habits')).first()).toBeVisible()
  const shown = await panes(shell, 'any')
  expect(shown.length).toBeGreaterThanOrEqual(2)
  const p1 = await box(shell, sel('pane-p1'))
  const habits = shown.find(
    (p) => p.id !== 'p1' && p.active !== null && p.active.startsWith('tab:'),
  )!
  const side = await box(shell, sel(`pane-${habits.id}`))
  expect(side.x).toBeGreaterThan(p1.x + p1.width)
})

test('closing the last app tab leaves a Dashboard tab; closing the last tool tab closes its pane', async ({
  shell,
}) => {
  await shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.openPlace('jobs', true))
  await expect.poll(async () => (await panes(shell, 'app'))[0]!.tabs.length).toBe(2)
  for (;;) {
    const [p1] = await panes(shell, 'app')
    const close = shell.locator(`${sel('pane-p1')} .eva-tab-close`).first()
    if (p1!.tabs.length === 1) {
      await shell
        .locator(`${sel('pane-p1')} .eva-tab`)
        .first()
        .hover()
      await close.click()
      break
    }
    await close.click()
    await expect
      .poll(async () => (await panes(shell, 'app'))[0]!.tabs.length)
      .toBe(p1!.tabs.length - 1)
  }
  // The pane holding the app tabs never closes: a fresh Dashboard tab is there.
  await expect
    .poll(() =>
      shell.evaluate(() =>
        (window as unknown as ShellHooks).__evaosShell.tabs().list.map((t) => t.page),
      ),
    )
    .toEqual(['dashboard'])
  await expect(shell.locator(sel('pane-p1'))).toBeVisible()
  await expect(shell.locator(`${sel('pane-body-p1')} ${sel('page-dashboard')}`)).toBeVisible()

  // Tool tabs: closing Files and then Browser closes the pane.
  await shell.locator(sel('pane-tab-files')).click()
  await shell.locator(sel('pane-tab-close-files')).click()
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p2', tabs: ['browser'], active: 'browser' }])
  await shell.locator(sel('pane-tab-close-browser')).click()
  await expect.poll(() => panes(shell)).toEqual([])
  await expect(shell.locator(sel('pane-p1'))).toBeVisible()
})
